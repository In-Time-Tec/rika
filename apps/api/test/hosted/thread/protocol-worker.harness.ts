import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { CommandId, IdempotencyKey, ThreadEventCursor, ThreadId, ThreadVersion } from "@rika/product/hosted-model"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { rikaHostedThreadProtocolCommands } from "@rika/product-store/database-schema"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { DateTime, Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { HostedThreadApplication } from "../../../src/hosted/thread/application"
import { layer as hostedThreadCommandWorkerLayer } from "../../../src/hosted/thread/command-worker"
import { HostedProduct } from "../../../src/hosted/product"
import { HostedWorkspace } from "../../../src/hosted/environment/workspace"
import { layerTest as hostedWorkerRuntimeLayerTest } from "../../../src/hosted/worker-runtime"
import { command, completeMockPrompt } from "./protocol/commands.harness"
import { live, setup, withDatabase } from "./protocol/database.harness"
import { fakeApplication, fakeProduct, fakeWorkspace } from "./protocol/fakes.harness"
import { actor, deviceId, later, ownerId, snapshot, threadId } from "./protocol/values.harness"

it.effect.skipIf(!live)("applies an admitted prompt without client traffic and recovers interrupted completion", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const authority = yield* HostedClientAuthority
      let completionAttempts = 0
      let admissionAttempts = 0
      const admittedEffects = new Set<string>()
      const admittedTurnIds = new Set<string>()
      const workerProtocol = ThreadProtocolStore.of({
        ...protocol,
        completeCommand: (input) => {
          if (input.commandId !== "server-owned-submit") return protocol.completeCommand(input)
          completionAttempts += 1
          return completionAttempts === 1
            ? Effect.fail(
                HostedPersistenceError.make({
                  reason: "database",
                  message: "simulated API interruption",
                }),
              )
            : protocol.completeCommand(input)
        },
      })
      const product = fakeProduct({
        admitAuthorizedRun: (input) =>
          Effect.sync(() => {
            admissionAttempts += 1
            admittedEffects.add(input.operationKey)
            admittedTurnIds.add(input.turnId)
          }).pipe(Effect.andThen(completeMockPrompt(workerProtocol, input, "accepted"))),
      })
      const operations = fakeApplication({
        snapshot: () => Effect.succeed(snapshot),
      })
      yield* Layer.build(
        hostedThreadCommandWorkerLayer({
          claimMillis: 10_000,
          fallbackIntervalMillis: 250,
        }).pipe(
          Layer.provide(hostedWorkerRuntimeLayerTest),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ThreadProtocolStore, workerProtocol),
              Layer.succeed(HostedClientAuthority, authority),
              Layer.succeed(HostedProduct, product),
              Layer.succeed(HostedThreadApplication, operations),
              Layer.succeed(HostedWorkspace, fakeWorkspace()),
              BunCrypto.layer,
            ),
          ),
        ),
      )
      const create = {
        ...command("server-owned-create", "0"),
        command: {
          _tag: "CreateThread",
          commandId: CommandId.make("server-owned-create"),
          idempotencyKey: IdempotencyKey.make("server-owned-create-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          owner: { kind: "personal" },
          executorKind: "runner",
          runnerTarget: { deviceId, checkoutFingerprint: "checkout-1" },
        },
      }
      yield* protocol.admitCommand(create)
      let creationCompleted = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        const current = yield* protocol.admitCommand(create)
        if (current.command.state === "completed") {
          creationCompleted = true
          expect(current.command.result).toEqual({
            _tag: "ThreadCreated",
            threadId,
          })
          break
        }
      }
      expect(creationCompleted).toBe(true)
      const input = {
        ...command("server-owned-submit", "1"),
        command: {
          _tag: "SubmitPrompt",
          threadId,
          commandId: CommandId.make("server-owned-submit"),
          idempotencyKey: IdempotencyKey.make("server-owned-submit-key"),
          expectedThreadVersion: ThreadVersion.make("1"),
          text: "continue after the socket closes",
          submissionId: "submission-1",
        },
      }
      yield* protocol.admitCommand(input)

      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        yield* protocol.admitCommand(input)
        if (completionAttempts > 0) break
      }
      expect(completionAttempts).toBe(1)
      yield* Effect.tryPromise(() =>
        drizzle({ client: pool })
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimExpiresAt: DateTime.toDate(DateTime.makeUnsafe(0)) })
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.threadId, threadId),
              eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
            ),
          ),
      )

      let completed: Effect.Success<ReturnType<typeof protocol.admitCommand>>["command"] | undefined
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        const current = yield* protocol.admitCommand(input)
        if (current.command.state === "completed") {
          completed = current.command
          break
        }
      }
      expect(completed).toMatchObject({
        state: "completed",
        result: { _tag: "PromptAdmitted", status: "accepted" },
        cursor: "1",
      })
      expect(completionAttempts).toBe(2)
      expect(admissionAttempts).toBe(2)
      expect(admittedEffects).toEqual(new Set(["server-owned-submit"]))
      expect(admittedTurnIds).toEqual(new Set([input.turnId]))
      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        includeSnapshot: false,
        limit: 100,
      })
      expect(replay.events).toMatchObject([
        {
          event: { _tag: "SubmissionAdmitted", submissionId: "submission-1" },
        },
      ])
    }),
  ),
)
it.effect.skipIf(!live)("lets command cancellation finish before a delayed prompt application", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const authority = yield* HostedClientAuthority
      const releasePrompt = yield* Deferred.make<void>()
      const cancelledPrompts = new Set<string>()
      const admittedPrompts = new Set<string>()
      const product = fakeProduct({
        admitAuthorizedRun: (input) =>
          Deferred.await(releasePrompt).pipe(
            Effect.map(() => {
              if (cancelledPrompts.has(input.operationKey))
                return {
                  _tag: "Cancelled" as const,
                  commandId: input.operationKey,
                }
              admittedPrompts.add(input.operationKey)
              return {
                _tag: "Admitted" as const,
                commandId: input.operationKey,
                turnId: `turn-${input.operationKey}`,
                status: "accepted" as const,
              }
            }),
          ),
        cancelAuthorizedRunAdmission: (input) => {
          const cancellation: Parameters<ThreadProtocolStore["Service"]["cancelPrompt"]>[0] = {
            ownerId: input.authority.ownerId,
            threadId: ThreadId.make(input.threadId),
            cancelCommandId: CommandId.make(input.cancelCommandId),
            targetCommandId: CommandId.make(input.targetCommandId),
            actor: input.authority.actor,
            cancelledAt: later,
          }
          if (input.claimToken !== undefined) Object.assign(cancellation, { claimToken: input.claimToken })
          return protocol.cancelPrompt(cancellation).pipe(
            Effect.orDie,
            Effect.tap(() => Effect.sync(() => cancelledPrompts.add(input.targetCommandId))),
            Effect.map((resolution) => (resolution._tag === "Turn" ? { turnId: String(resolution.turnId) } : {})),
          )
        },
      })
      const operations = fakeApplication({
        snapshot: () => Effect.succeed(snapshot),
      })
      yield* Layer.build(
        hostedThreadCommandWorkerLayer({
          claimMillis: 10_000,
          fallbackIntervalMillis: 250,
          concurrency: 2,
        }).pipe(
          Layer.provide(hostedWorkerRuntimeLayerTest),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ThreadProtocolStore, protocol),
              Layer.succeed(HostedClientAuthority, authority),
              Layer.succeed(HostedProduct, product),
              Layer.succeed(HostedThreadApplication, operations),
              Layer.succeed(HostedWorkspace, fakeWorkspace()),
              BunCrypto.layer,
            ),
          ),
        ),
      )
      const submit = {
        ...command("delayed-submit", "0"),
        command: {
          _tag: "SubmitPrompt",
          threadId,
          commandId: CommandId.make("delayed-submit"),
          idempotencyKey: IdempotencyKey.make("delayed-submit-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          text: "must remain cancelled",
          submissionId: "submission-1",
        },
      }
      const cancel = {
        ...command("cancel-delayed-submit", "1"),
        command: {
          _tag: "Cancel",
          threadId,
          commandId: CommandId.make("cancel-delayed-submit"),
          idempotencyKey: IdempotencyKey.make("cancel-delayed-submit-key"),
          expectedThreadVersion: ThreadVersion.make("1"),
          target: {
            _tag: "Command",
            commandId: CommandId.make("delayed-submit"),
          },
        },
      }
      yield* protocol.admitCommand(submit)
      yield* protocol.admitCommand(cancel)

      let cancelled = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        if ((yield* protocol.admitCommand(cancel)).command.state === "completed") {
          cancelled = true
          break
        }
      }
      expect(cancelled).toBe(true)
      expect(cancelledPrompts).toEqual(new Set(["delayed-submit"]))
      yield* Deferred.succeed(releasePrompt, undefined)

      let submitCompleted = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        if ((yield* protocol.admitCommand(submit)).command.state === "completed") {
          submitCompleted = true
          break
        }
      }
      expect(submitCompleted).toBe(true)
      expect(admittedPrompts).toEqual(new Set())
      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        includeSnapshot: false,
        limit: 100,
      })
      expect(replay.events).toMatchObject([
        {
          event: {
            _tag: "ExecutionControlled",
            action: "cancelled",
            agentResponseArrived: false,
          },
        },
      ])
    }),
  ),
)
