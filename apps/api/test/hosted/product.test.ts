import {
  expect,
  it,
  identityUser,
  ExecutionGateway,
  DeviceId,
  WorkspaceId,
  CheckoutFingerprint,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolEvents,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaTurns,
  rikaWorkspaces,
  HostedTurnWorkerStore,
  asc,
  eq,
  inArray,
  sql,
  Clock,
  DateTime,
  Effect,
  HostedProduct,
  Runtime,
  live,
  principal,
  personal,
  failureKind,
  requireAdmitted,
  hostedProductFixture,
} from "./product/fixture"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import "./product/admission.harness"
import "./product/authorization.harness"
import "./product/workspace.harness"

const { withAuthoritativeDatabase, withDatabase } = hostedProductFixture

it.effect.skipIf(!live)("commits the canonical command, Turn, and Generalist Run atomically", () =>
  withAuthoritativeDatabase("atomic-run", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("atomic-run-user")
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
      const runtime = yield* Runtime.Runtime
      const fingerprint = CheckoutFingerprint.make("atomic-run-checkout")
      yield* product.registerRunner({
        principal: authenticated,
        checkoutFingerprint: fingerprint,
        registration: {
          protocolVersion: runnerProtocolVersion,
          workspaceIdentity: WorkspaceId.make("atomic-run-workspace"),
          repository: { identity: "In-Time-Tec/rika", branch: "main" },
          nativeToolRuntime: { runtime: "bun", runtimeVersion: Bun.version, trustMode: "trusted-local" },
          capabilities: { nativeTools: true, checkpoints: false, pty: false },
        },
      })
      const connection = yield* product.createConnection({
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "runner",
        runnerTarget: { deviceId: DeviceId.make(authenticated.deviceId), checkoutFingerprint: fingerprint },
      })
      const input = {
        principal: authenticated,
        threadId: connection.threadId,
        operationKey: "atomic-run-command",
        prompt: "stage this Run atomically",
      } as const
      yield* Effect.tryPromise(() =>
        database.execute(
          sql.raw(`CREATE FUNCTION reject_atomic_run_completion() RETURNS TRIGGER LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected command completion failure'; END $$;
            CREATE TRIGGER reject_atomic_run_completion
            BEFORE UPDATE ON rika_hosted_thread_protocol_commands
            FOR EACH ROW WHEN (OLD.state = 'admitted' AND NEW.state = 'completed')
            EXECUTE FUNCTION reject_atomic_run_completion();`),
        ),
      )
      const failed = yield* product.admitRun(input).pipe(Effect.result)
      expect(failed).toMatchObject({ _tag: "Failure" })
      const rolledBack = {
        commands: yield* Effect.tryPromise(() =>
          database
            .select({ state: rikaHostedThreadProtocolCommands.state })
            .from(rikaHostedThreadProtocolCommands)
            .where(eq(rikaHostedThreadProtocolCommands.threadId, connection.threadId)),
        ),
        turns: yield* Effect.tryPromise(() => database.$count(rikaTurns, eq(rikaTurns.threadId, connection.threadId))),
        runs: yield* runtime.list({ limit: 100 }).pipe(Effect.map((runs) => runs.length)),
        events: yield* Effect.tryPromise(() =>
          database.$count(
            rikaHostedThreadProtocolEvents,
            eq(rikaHostedThreadProtocolEvents.threadId, connection.threadId),
          ),
        ),
      }
      expect(rolledBack).toEqual({ commands: [{ state: "admitted" }], turns: 0, runs: 0, events: 0 })
      yield* Effect.tryPromise(() =>
        database.execute(
          sql.raw(`DROP TRIGGER reject_atomic_run_completion ON rika_hosted_thread_protocol_commands;
            DROP FUNCTION reject_atomic_run_completion();`),
        ),
      )
      const admitted = yield* requireAdmitted(product.admitRun(input))
      expect(yield* product.admitRun(input)).toEqual(admitted)
      expect(yield* failureKind(product.admitRun({ ...input, prompt: "different payload" }))).toBe("conflict")
      const committed = {
        commands: yield* Effect.tryPromise(() =>
          database
            .select({
              state: rikaHostedThreadProtocolCommands.state,
              workState: rikaHostedThreadProtocolCommands.workState,
              turnId: rikaHostedThreadProtocolCommands.turnId,
              result: rikaHostedThreadProtocolCommands.result,
            })
            .from(rikaHostedThreadProtocolCommands)
            .where(eq(rikaHostedThreadProtocolCommands.threadId, connection.threadId)),
        ),
        title: yield* Effect.tryPromise(() =>
          database
            .select({ title: rikaThreads.title })
            .from(rikaThreads)
            .where(eq(rikaThreads.id, connection.threadId)),
        ),
        turns: yield* Effect.tryPromise(() => database.$count(rikaTurns, eq(rikaTurns.threadId, connection.threadId))),
        runs: yield* runtime.list({ limit: 100 }).pipe(Effect.map((runs) => runs.length)),
        events: yield* Effect.tryPromise(() =>
          database.$count(
            rikaHostedThreadProtocolEvents,
            eq(rikaHostedThreadProtocolEvents.threadId, connection.threadId),
          ),
        ),
      }
      expect(committed).toEqual({
        commands: [
          {
            state: "completed",
            workState: "turn-activation-pending",
            turnId: admitted.turnId,
            result: { _tag: "PromptAdmitted", status: "accepted" },
          },
        ],
        title: [{ title: input.prompt }],
        turns: 1,
        runs: 2,
        events: 2,
      })

      const turnWorkerStore = yield* HostedTurnWorkerStore
      const gateway = yield* ExecutionGateway.Service
      const firstClaim = yield* turnWorkerStore.claimNext({
        workerId: "activation-worker-1",
        claimToken: "activation-claim-1",
        leaseMillis: 30_000,
      })
      if (firstClaim === undefined) return yield* Effect.die("Staged Run activation was not claimed")
      expect(firstClaim).toMatchObject({
        activationRequested: false,
        input: { threadId: connection.threadId, turnId: admitted.turnId },
        admissionLink: { threadId: connection.threadId, turnId: admitted.turnId },
        preparedExecution: { threadId: connection.threadId, turnId: admitted.turnId },
      })
      expect(firstClaim.expiresAt - firstClaim.claimedAt).toBe(30_000)
      expect(yield* turnWorkerStore.requestActivation(firstClaim, yield* Clock.currentTimeMillis)).toBe(true)
      const firstActivation = yield* gateway.activateTurn(firstClaim.preparedExecution, firstClaim.admissionLink)
      yield* Effect.tryPromise(() =>
        database
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimExpiresAt: sql`transaction_timestamp() - interval '1 millisecond'` })
          .where(eq(rikaHostedThreadProtocolCommands.commandId, input.operationKey)),
      )
      const recoveredClaim = yield* turnWorkerStore.claimNext({
        workerId: "activation-worker-2",
        claimToken: "activation-claim-2",
        leaseMillis: 30_000,
      })
      if (recoveredClaim === undefined) return yield* Effect.die("Unacknowledged Run activation was not recovered")
      expect(recoveredClaim.activationRequested).toBe(true)
      const recoveredActivation = yield* gateway.activateTurn(
        recoveredClaim.preparedExecution,
        recoveredClaim.admissionLink,
      )
      expect(["running", "waiting", "completed", "failed", "cancelled", "cancelling"]).toContain(firstActivation)
      expect(["running", "waiting", "completed", "failed", "cancelled", "cancelling"]).toContain(recoveredActivation)
      expect((yield* runtime.list({ limit: 100 })).length).toBe(2)
      yield* turnWorkerStore.completeActivation(recoveredClaim, recoveredActivation, yield* Clock.currentTimeMillis)
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({
              workState: rikaHostedThreadProtocolCommands.workState,
              claimToken: rikaHostedThreadProtocolCommands.claimToken,
            })
            .from(rikaHostedThreadProtocolCommands)
            .where(eq(rikaHostedThreadProtocolCommands.commandId, input.operationKey)),
        ),
      ).toEqual([{ workState: null, claimToken: null }])
    }),
  ),
)

it.effect.skipIf(!live)("reuses deterministic Thread creation after a lost response", () =>
  withDatabase("create-retry", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("create-retry-user")
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
      const input = {
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "orb" as const,
        threadId: "create-retry-thread",
      }
      const first = yield* product.createConnection(input)
      expect(yield* product.createConnection(input)).toEqual(first)
      expect(
        yield* Effect.all(
          Array.from({ length: 8 }, () => product.createConnection(input)),
          {
            concurrency: "unbounded",
          },
        ),
      ).toEqual(Array.from({ length: 8 }, () => first))
      const [threads, workspaces, assignments] = yield* Effect.all([
        Effect.orDie(
          Effect.tryPromise(() => database.$count(rikaHostedThreads, eq(rikaHostedThreads.id, input.threadId))),
        ),
        Effect.orDie(
          Effect.tryPromise(() =>
            database.$count(rikaHostedWorkspaces, eq(rikaHostedWorkspaces.id, `${input.threadId}-workspace`)),
          ),
        ),
        Effect.orDie(
          Effect.tryPromise(() =>
            database.$count(rikaHostedExecutorAssignments, eq(rikaHostedExecutorAssignments.threadId, input.threadId)),
          ),
        ),
      ])
      expect([{ threads, workspaces, assignments }]).toEqual([{ threads: 1, workspaces: 1, assignments: 1 }])
      const project = yield* product.createProject({
        principal: authenticated,
        owner: personal(authenticated.userId),
        name: "Divergent retry",
      })
      expect(yield* failureKind(product.createConnection({ ...input, projectId: project.id }))).toBe("conflict")
    }),
  ),
)

it.effect.skipIf(!live)("rolls back failed aggregate creation and rejects one-sided Thread state", () =>
  withDatabase("aggregate-invariant", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("aggregate-invariant-user")
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
      yield* Effect.tryPromise(() =>
        database.execute(
          sql.raw(`CREATE FUNCTION reject_aggregate_product_thread() RETURNS TRIGGER LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected aggregate failure'; END $$;
            CREATE TRIGGER reject_aggregate_product_thread BEFORE INSERT ON rika_threads
            FOR EACH ROW EXECUTE FUNCTION reject_aggregate_product_thread();`),
        ),
      )
      const product = yield* HostedProduct
      const threadId = "aggregate-rollback-thread"
      expect(
        yield* product
          .createConnection({
            principal: authenticated,
            owner: personal(authenticated.userId),
            executorKind: "orb",
            threadId,
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" })
      yield* Effect.tryPromise(() =>
        database.execute(
          sql.raw(`DROP TRIGGER reject_aggregate_product_thread ON rika_threads;
          DROP FUNCTION reject_aggregate_product_thread();`),
        ),
      )
      const rolledBack = {
        hostedThreads: yield* Effect.tryPromise(() =>
          database.$count(rikaHostedThreads, eq(rikaHostedThreads.id, threadId)),
        ),
        hostedWorkspaces: yield* Effect.tryPromise(() =>
          database.$count(rikaHostedWorkspaces, eq(rikaHostedWorkspaces.id, `${threadId}-workspace`)),
        ),
        threads: yield* Effect.tryPromise(() => database.$count(rikaThreads, eq(rikaThreads.id, threadId))),
        workspaces: yield* Effect.tryPromise(() =>
          database.$count(rikaWorkspaces, eq(rikaWorkspaces.path, `${threadId}-workspace`)),
        ),
      }
      expect(rolledBack).toEqual({ hostedThreads: 0, hostedWorkspaces: 0, threads: 0, workspaces: 0 })

      const owners = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedOwners.id })
          .from(rikaHostedOwners)
          .where(eq(rikaHostedOwners.userId, authenticated.userId)),
      )
      const ownerId = owners[0]?.id
      if (ownerId === undefined) return yield* Effect.die("Aggregate rollback owner was not created")
      yield* Effect.tryPromise(() =>
        database.insert(rikaHostedWorkspaces).values({
          id: "hosted-orphan-workspace",
          ownerId,
          createdByUserId: authenticated.userId,
          executorKind: "orb",
          inheritProjectGrants: false,
          createdAt,
        }),
      )
      expect(
        yield* Effect.tryPromise(() =>
          database.transaction((tx) =>
            tx.insert(rikaHostedThreads).values({
              id: "hosted-orphan-thread",
              ownerId,
              workspaceId: "hosted-orphan-workspace",
              createdByUserId: authenticated.userId,
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt,
            }),
          ),
        ).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" })
      yield* Effect.tryPromise(() =>
        database.insert(rikaWorkspaces).values({ ownerId, path: "product-orphan-workspace", createdAt: 1 }),
      )
      expect(
        yield* Effect.tryPromise(() =>
          database.transaction((tx) =>
            tx.insert(rikaThreads).values({
              id: "product-orphan-thread",
              ownerId,
              workspace: "product-orphan-workspace",
              title: "Orphan",
              createdAt: 1,
              updatedAt: 1,
            }),
          ),
        ).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" })
      const orphans = {
        hosted: yield* Effect.tryPromise(() =>
          database.$count(rikaHostedThreads, eq(rikaHostedThreads.id, "hosted-orphan-thread")),
        ),
        product: yield* Effect.tryPromise(() =>
          database.$count(rikaThreads, eq(rikaThreads.id, "product-orphan-thread")),
        ),
      }
      expect(orphans).toEqual({ hosted: 0, product: 0 })
    }),
  ),
)

it.effect.skipIf(!live)("atomically archives a Thread while creating its replacement", () =>
  withDatabase("atomic-replacement", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("atomic-replacement-user")
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
      const base = {
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "orb" as const,
      }
      yield* product.createConnection({ ...base, threadId: "source-thread" })
      yield* product.createConnection({ ...base, threadId: "other-source-thread" })
      const replacement = {
        ...base,
        threadId: "replacement-thread",
        archiveThreadId: "source-thread",
      }
      const created = yield* product.createConnection(replacement)
      expect(yield* product.createConnection(replacement)).toEqual(created)
      expect(
        yield* failureKind(product.createConnection({ ...replacement, archiveThreadId: "other-source-thread" })),
      ).toBe("conflict")
      expect(
        yield* failureKind(
          product.createConnection({ ...base, threadId: "missing-replacement", archiveThreadId: "missing-thread" }),
        ),
      ).toBe("not-found")
      expect(
        yield* failureKind(
          product.createConnection({ ...base, threadId: "self-replacement", archiveThreadId: "self-replacement" }),
        ),
      ).toBe("conflict")
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ id: rikaThreads.id, archived: rikaThreads.archived })
            .from(rikaThreads)
            .where(inArray(rikaThreads.id, ["source-thread", "other-source-thread", "replacement-thread"]))
            .orderBy(asc(rikaThreads.id)),
        ),
      ).toEqual([
        { id: "other-source-thread", archived: 0 },
        { id: "replacement-thread", archived: 0 },
        { id: "source-thread", archived: 1 },
      ])
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ archiveSourceThreadId: rikaHostedThreads.archiveSourceThreadId })
            .from(rikaHostedThreads)
            .where(eq(rikaHostedThreads.id, "replacement-thread")),
        ),
      ).toEqual([{ archiveSourceThreadId: "source-thread" }])
      expect(
        yield* Effect.tryPromise(() =>
          database.$count(
            rikaHostedThreads,
            inArray(rikaHostedThreads.id, ["missing-replacement", "self-replacement"]),
          ),
        ),
      ).toBe(0)
    }),
  ),
)
