import {
  expect,
  it,
  identityUser,
  DeviceId,
  WorkspaceId,
  CheckoutFingerprint,
  rikaHostedExecutorAssignments,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreads,
  rikaThreadQueueState,
  rikaTurnAdmissionOutbox,
  rikaTurns,
  asc,
  rowCount,
  eq,
  inArray,
  DateTime,
  Effect,
  Ref,
  Schema,
  HostedProduct,
  live,
  principal,
  personal,
  failureKind,
  requireAdmitted,
  hostedProductFixture,
} from "./fixture"
import { runnerProtocolVersion } from "@rika/product/runner-registration"

const { decodeExecutionRoute, decodePromptParts, encodeStartTurn, withDatabase } = hostedProductFixture

it.effect.skipIf(!live)("serializes prompt admission against cancellation in both commit orders", () =>
  withDatabase("prompt-cancellation", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "cancellation-user",
          name: "cancellation-user",
          email: "cancellation-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const authenticated = principal("cancellation-user")
      const product = yield* HostedProduct
      const connection = yield* product.createConnection({
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "orb",
      })
      expect(
        yield* product.cancelRunAdmission({
          principal: authenticated,
          threadId: connection.threadId,
          cancelCommandId: "cancel-first",
          targetCommandId: "submit-cancelled",
        }),
      ).toEqual({})
      expect(
        yield* product.admitRun({
          principal: authenticated,
          threadId: connection.threadId,
          operationKey: "submit-cancelled",
          prompt: "must never execute",
        }),
      ).toEqual({ _tag: "Cancelled", commandId: "submit-cancelled" })
      const admitted = yield* requireAdmitted(
        product.admitRun({
          principal: authenticated,
          threadId: connection.threadId,
          operationKey: "submit-admitted",
          prompt: "cancel this exact Turn",
        }),
      )
      expect(
        yield* product.cancelRunAdmission({
          principal: authenticated,
          threadId: connection.threadId,
          cancelCommandId: "cancel-second",
          targetCommandId: "submit-admitted",
        }),
      ).toEqual({ turnId: admitted.turnId })
      const commands = yield* Effect.tryPromise(() =>
        database
          .select({
            command_id: rikaHostedThreadProtocolCommands.commandId,
            turn_id: rikaHostedThreadProtocolCommands.turnId,
          })
          .from(rikaHostedThreadProtocolCommands)
          .where(eq(rikaHostedThreadProtocolCommands.threadId, connection.threadId))
          .orderBy(asc(rikaHostedThreadProtocolCommands.commandId)),
      )
      expect(commands.map(({ command_id }) => command_id)).toEqual([
        "cancel-first",
        "cancel-second",
        "submit-admitted",
        "submit-cancelled",
      ])
      expect(commands.map(({ turn_id }) => turn_id)).toEqual([null, null, admitted.turnId, commands[3]?.turn_id])
      expect(commands[3]?.turn_id).not.toBeNull()
    }),
  ),
)

it.effect.skipIf(!live)("rejects new prompts without mutation and replays them through outage and recovery", () =>
  Effect.gen(function* () {
    const ready = yield* Ref.make(false)
    yield* withDatabase(
      "prompt-readiness",
      (database) =>
        Effect.gen(function* () {
          const createdAt = DateTime.toDate(DateTime.nowUnsafe())
          yield* Effect.tryPromise(() =>
            database.insert(identityUser).values({
              id: "prompt-readiness-user",
              name: "prompt-readiness-user",
              email: "prompt-readiness-user@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            }),
          )
          const product = yield* HostedProduct
          const connection = yield* product.createConnection({
            principal: principal("prompt-readiness-user"),
            owner: personal("prompt-readiness-user"),
            executorKind: "orb",
          })
          const input = {
            principal: principal("prompt-readiness-user"),
            threadId: connection.threadId,
            operationKey: "readiness-command",
            prompt: "ready prompt",
          } as const
          expect(yield* failureKind(product.admitRun(input))).toBe("unavailable")
          const [commands, turns, queues] = yield* Effect.all([
            Effect.orDie(
              Effect.tryPromise(() =>
                database.$count(
                  rikaHostedThreadProtocolCommands,
                  eq(rikaHostedThreadProtocolCommands.threadId, connection.threadId),
                ),
              ),
            ),
            Effect.orDie(
              Effect.tryPromise(() => database.$count(rikaTurns, eq(rikaTurns.threadId, connection.threadId))),
            ),
            Effect.orDie(
              Effect.tryPromise(() =>
                database.$count(rikaThreadQueueState, eq(rikaThreadQueueState.threadId, connection.threadId)),
              ),
            ),
          ])
          expect([{ commands, turns, queues }]).toMatchObject([{ commands: 1, turns: 0, queues: 0 }])
          yield* Ref.set(ready, true)
          const admitted = yield* product.admitRun(input)
          yield* Ref.set(ready, false)
          expect(yield* product.admitRun(input)).toEqual(admitted)
          expect(
            yield* failureKind(
              product.admitRun({
                ...input,
                operationKey: "new-during-outage",
              }),
            ),
          ).toBe("unavailable")
          yield* Ref.set(ready, true)
          expect((yield* requireAdmitted(product.admitRun({ ...input, operationKey: "after-recovery" }))).status).toBe(
            "queued",
          )
        }),
      Ref.get(ready),
    )
  }),
)

it.effect.skipIf(!live)("admits concurrent duplicate prompts with one mutation", () =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0)
    const readiness = Ref.update(checks, (count) => count + 1).pipe(Effect.as(true))
    yield* withDatabase(
      "prompt-readiness-race",
      (database) =>
        Effect.gen(function* () {
          const createdAt = DateTime.toDate(DateTime.nowUnsafe())
          yield* Effect.tryPromise(() =>
            database.insert(identityUser).values({
              id: "prompt-readiness-race-user",
              name: "prompt-readiness-race-user",
              email: "prompt-readiness-race-user@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            }),
          )
          const product = yield* HostedProduct
          const connection = yield* product.createConnection({
            principal: principal("prompt-readiness-race-user"),
            owner: personal("prompt-readiness-race-user"),
            executorKind: "orb",
          })
          const input = {
            principal: principal("prompt-readiness-race-user"),
            threadId: connection.threadId,
            operationKey: "racing-command",
            prompt: "racing prompt",
          } as const
          const results = yield* Effect.all([product.admitRun(input), product.admitRun(input)], { concurrency: 2 })
          expect(results[1]).toEqual(results[0])
          expect(yield* Ref.get(checks)).toBe(2)
          expect(
            yield* Effect.tryPromise(() => database.$count(rikaTurns, eq(rikaTurns.threadId, connection.threadId))),
          ).toBe(1)
        }),
      readiness,
    )
  }),
)

it.effect.skipIf(!live)("serializes the first prompt lane without queue-count drift", () =>
  withDatabase("prompt-lane", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "prompt-lane-user",
          name: "prompt-lane-user",
          email: "prompt-lane-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      const connection = yield* product.createConnection({
        principal: principal("prompt-lane-user"),
        owner: personal("prompt-lane-user"),
        executorKind: "orb",
      })
      const inputs = Array.from({ length: 8 }, (_, index) => ({
        principal: principal("prompt-lane-user"),
        threadId: connection.threadId,
        operationKey: `concurrent-prompt-${index}`,
        prompt: `concurrent prompt ${index}`,
      }))
      const admitted = yield* Effect.all(
        inputs.map((input) => requireAdmitted(product.admitRun(input))),
        { concurrency: "unbounded" },
      )
      const lanes = yield* Effect.tryPromise(() =>
        database
          .select({ status: rikaTurns.status, count: rowCount() })
          .from(rikaTurns)
          .where(eq(rikaTurns.threadId, connection.threadId))
          .groupBy(rikaTurns.status)
          .orderBy(asc(rikaTurns.status)),
      )
      expect(lanes).toEqual([
        { status: "accepted", count: 1 },
        { status: "queued", count: 7 },
      ])
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ queued_count: rikaThreadQueueState.queuedCount })
            .from(rikaThreadQueueState)
            .where(eq(rikaThreadQueueState.threadId, connection.threadId)),
        ),
      ).toMatchObject([{ queued_count: 7 }])
      const accepted = lanes.find((lane) => lane.status === "accepted")
      expect(accepted?.count).toBe(1)
      expect(admitted.map((item) => item.status).toSorted()).toEqual([
        "accepted",
        "queued",
        "queued",
        "queued",
        "queued",
        "queued",
        "queued",
        "queued",
      ])
    }),
  ),
)

it.effect.skipIf(!live)("admits a current local Thread without recovering an unrelated stale admission", () =>
  withDatabase("local-admission", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("local-user")
      const fingerprint = CheckoutFingerprint.make("local-checkout")
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: authenticated.userId,
          name: authenticated.userId,
          email: `${authenticated.userId}@example.test`,
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      const workspaceIdentity = yield* Schema.decodeEffect(WorkspaceId)("local-workspace")
      yield* product.registerRunner({
        principal: authenticated,
        checkoutFingerprint: fingerprint,
        registration: {
          protocolVersion: runnerProtocolVersion,
          workspaceIdentity,
          repository: { identity: "In-Time-Tec/rika", branch: "main" },
          kernel: {
            runtime: "bun",
            runtimeVersion: Bun.version,
            trustMode: "trusted-local",
          },
          capabilities: { cells: true, checkpoints: false, pty: false },
        },
      })
      const deviceId = yield* Schema.decodeEffect(DeviceId)(authenticated.deviceId)
      const createLocal = () =>
        product.createConnection({
          principal: authenticated,
          owner: personal(authenticated.userId),
          executorKind: "runner",
          runnerTarget: { deviceId, checkoutFingerprint: fingerprint },
        })
      const staleThread = yield* createLocal()
      const staleRun = yield* requireAdmitted(
        product.admitRun({
          principal: authenticated,
          threadId: staleThread.threadId,
          operationKey: "stale-operation",
          prompt: "stale prompt",
        }),
      )
      const staleRows = yield* Effect.tryPromise(() =>
        database
          .select({
            workspace_id: rikaHostedThreads.workspaceId,
            execution_route_json: rikaTurns.executionRouteJson,
          })
          .from(rikaTurns)
          .innerJoin(rikaHostedThreads, eq(rikaHostedThreads.id, rikaTurns.threadId))
          .where(eq(rikaTurns.id, staleRun.turnId)),
      )
      const staleRow = staleRows[0]
      if (staleRow === undefined) return yield* Effect.die("Stale Turn was not persisted")
      const staleInput = {
        threadId: staleThread.threadId,
        turnId: staleRun.turnId,
        workspaceId: staleRow.workspace_id,
        prompt: "stale prompt",
        executionRoute: decodeExecutionRoute(staleRow.execution_route_json),
      }
      yield* Effect.tryPromise(() =>
        database.update(rikaTurns).set({ status: "running" }).where(eq(rikaTurns.id, staleRun.turnId)),
      )
      yield* Effect.tryPromise(() =>
        database
          .update(rikaThreadQueueState)
          .set({ queuedCount: 0 })
          .where(eq(rikaThreadQueueState.threadId, staleThread.threadId)),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(rikaTurnAdmissionOutbox)
          .values({ turnId: staleRun.turnId, startInputJson: encodeStartTurn(staleInput), preparedAt: 1 }),
      )
      yield* Effect.tryPromise(() =>
        database
          .delete(rikaHostedExecutorAssignments)
          .where(eq(rikaHostedExecutorAssignments.threadId, staleThread.threadId)),
      )

      const currentThread = yield* createLocal()
      const promptParts = [
        {
          type: "image" as const,
          mediaType: "image/png",
          data: "aW1hZ2U=",
          filename: "evidence.png",
        },
      ]
      const currentRun = yield* requireAdmitted(
        product.admitRun({
          principal: authenticated,
          threadId: currentThread.threadId,
          operationKey: "current-operation",
          prompt: "current prompt",
          promptParts,
          mode: "high",
        }),
      )
      const turns = yield* Effect.tryPromise(() =>
        database
          .select({
            id: rikaTurns.id,
            status: rikaTurns.status,
            prompt_parts_json: rikaTurns.promptPartsJson,
            execution_route_json: rikaTurns.executionRouteJson,
          })
          .from(rikaTurns)
          .where(inArray(rikaTurns.id, [staleRun.turnId, currentRun.turnId]))
          .orderBy(asc(rikaTurns.id)),
      )
      const stale = turns.find((row) => row.id === staleRun.turnId)
      const current = turns.find((row) => row.id === currentRun.turnId)
      expect(stale).toMatchObject({ status: "running" })
      expect(current).toMatchObject({ status: "accepted" })
      if (current === undefined) return yield* Effect.die("Current Turn was not persisted")
      expect(decodePromptParts(current.prompt_parts_json)).toEqual(promptParts)
      const route = decodeExecutionRoute(current.execution_route_json)
      expect(route.mode).toBe("high")
      expect(
        route.main.candidates.every(
          (candidate) =>
            candidate.providerConnection.provider === "openai" &&
            candidate.providerConnection.authentication === "account" &&
            candidate.providerConnection.credentialIdentity === "openai-account-test" &&
            candidate.providerConnection.accountFingerprint === "openai-fingerprint-test",
        ),
      ).toBe(true)
      expect(
        yield* Effect.tryPromise(() =>
          database.$count(rikaTurnAdmissionOutbox, eq(rikaTurnAdmissionOutbox.turnId, staleRun.turnId)),
        ),
      ).toBe(1)
    }),
  ),
)
