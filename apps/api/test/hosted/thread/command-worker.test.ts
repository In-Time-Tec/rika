import { describe, expect, it } from "@effect/vitest"
import { CommitCursor, Sequence, ThreadEventCursor, ThreadVersion, Timestamp } from "@rika/product/hosted-model"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { commandControlFailure } from "../../../src/hosted/thread/command-worker"
import { commandApplication } from "../../../src/hosted/thread/command-application"
import { HostedProduct, HostedProductError } from "../../../src/hosted/product"
import { HostedThreadApplication } from "../../../src/hosted/thread/application"
import { HostedWorkspace } from "../../../src/hosted/environment/workspace"
import { command } from "./protocol/commands.harness"
import { fakeApplication, fakeProduct, fakeWorkspace } from "./protocol/fakes.harness"
import { memoryStore, snapshot } from "./protocol/memory.fixture"

const cancellationFailure: InteractiveEvent = {
  _tag: "ExecutionControlFailed",
  action: "cancel",
  failure: {
    tag: "CancelTurnFailure",
    category: "operation",
    message: "Cancellation backend unavailable",
    retryable: true,
    retry: "none",
    actor: "environment",
  },
}

describe("hosted Thread command control failures", () => {
  it("rejects a Cancel command when durable cancellation failed", () => {
    expect(commandControlFailure({ _tag: "Cancel" }, [cancellationFailure])).toEqual(cancellationFailure)
  })

  it("does not apply another control action's failure to a command", () => {
    expect(commandControlFailure({ _tag: "Approve" }, [cancellationFailure])).toBeUndefined()
    expect(commandControlFailure({ _tag: "Steer" }, [cancellationFailure])).toBeUndefined()
  })
})

it.effect("leaves an unavailable command claimed until its durable retry lease expires", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let releases = 0
      const submissions: Array<Parameters<HostedProduct["Service"]["admitAuthorizedRun"]>[0]> = []
      const memory = memoryStore()
      const protocol = ThreadProtocolStore.of({
        ...memory,
        releaseCommandClaim: () =>
          Effect.sync(() => {
            releases += 1
          }),
      })
      const authority = HostedClientAuthority.of({
        registerDevice: () => Effect.die("unused"),
        authenticateClient: () => Effect.die("unused"),
        grantClientAuthority: () => Effect.die("unused"),
        findThread: () => Effect.die("unused"),
        readThread: () => Effect.die("unused"),
        authorizeThread: () => Effect.void,
      })
      const services = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(ThreadProtocolStore, protocol),
          Layer.succeed(HostedClientAuthority, authority),
          Layer.succeed(
            HostedProduct,
            fakeProduct({
              admitAuthorizedRun: (input) => {
                submissions.push(input)
                return Effect.fail(HostedProductError.make({ kind: "unavailable", message: "temporarily unavailable" }))
              },
            }),
          ),
          Layer.succeed(HostedThreadApplication, fakeApplication()),
          Layer.succeed(HostedWorkspace, fakeWorkspace()),
        ),
      )
      const execute = yield* commandApplication({ claimMillis: 10_000 }).pipe(Effect.provide(services))
      const admitted = {
        ...command("unavailable-submit", "0"),
        threadVersion: ThreadVersion.make("1"),
        sequence: Sequence.make("1"),
        commitCursor: CommitCursor.make("1"),
        state: "admitted" as const,
        command: {
          _tag: "SubmitPrompt" as const,
          text: "retry later",
          submissionId: "submission-1",
          review: true,
        },
      }

      expect((yield* Effect.exit(execute(admitted, "claim-1").pipe(Effect.provide(services))))._tag).toBe("Failure")
      expect(submissions).toMatchObject([{ review: true, prompt: "retry later", submissionId: "submission-1" }])
      expect(releases).toBe(0)
    }),
  ),
)

it.effect("rejects a submission whose Executor stayed unavailable past the admission deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const memory = memoryStore()
      const authority = HostedClientAuthority.of({
        registerDevice: () => Effect.die("unused"),
        authenticateClient: () => Effect.die("unused"),
        grantClientAuthority: () => Effect.die("unused"),
        findThread: () => Effect.die("unused"),
        readThread: () => Effect.die("unused"),
        authorizeThread: () => Effect.void,
      })
      const services = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(ThreadProtocolStore, memory),
          Layer.succeed(HostedClientAuthority, authority),
          Layer.succeed(
            HostedProduct,
            fakeProduct({
              admitAuthorizedRun: () =>
                Effect.fail(HostedProductError.make({ kind: "unavailable", message: "Rika service is unavailable" })),
            }),
          ),
          Layer.succeed(HostedThreadApplication, fakeApplication({ snapshot: () => Effect.succeed(snapshot) })),
          Layer.succeed(HostedWorkspace, fakeWorkspace()),
        ),
      )
      const execute = yield* commandApplication({ claimMillis: 10_000, admissionDeadlineMillis: 60_000 }).pipe(
        Effect.provide(services),
      )
      const admitted = {
        ...command("stale-submit", "0"),
        // The test clock starts at the epoch; the command was admitted then and two minutes have passed.
        admittedAt: Timestamp.make("1970-01-01T00:00:00.000Z"),
        threadVersion: ThreadVersion.make("1"),
        sequence: Sequence.make("1"),
        commitCursor: CommitCursor.make("1"),
        state: "admitted" as const,
        command: {
          _tag: "SubmitPrompt" as const,
          text: "never admitted",
          submissionId: "submission-stale",
        },
      }
      yield* memory.admitCommand(admitted)
      yield* TestClock.adjust("2 minutes")

      yield* execute(admitted, "claim-1").pipe(Effect.provide(services))

      const replay = yield* memory.replay({
        ownerId: admitted.ownerId,
        threadId: admitted.threadId,
        actor: admitted.actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 10,
        includeSnapshot: false,
      })
      expect(replay.events.map((entry) => entry.event)).toEqual([
        {
          _tag: "SubmissionRejected",
          threadId: admitted.threadId,
          message: "Rika service is unavailable",
          submissionId: "submission-stale",
        },
      ])
    }),
  ),
)
