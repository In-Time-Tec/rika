import { describe, expect, it } from "@effect/vitest"
import { CommitCursor, Sequence, ThreadVersion } from "@rika/product/hosted-model"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { Effect, Layer } from "effect"
import { commandControlFailure } from "../../../src/hosted/thread/command-worker"
import { commandApplication } from "../../../src/hosted/thread/command-application"
import { HostedProduct, HostedProductError } from "../../../src/hosted/product"
import { HostedThreadApplication } from "../../../src/hosted/thread/application"
import { HostedWorkspace } from "../../../src/hosted/environment/workspace"
import { command } from "./protocol/commands.harness"
import { fakeApplication, fakeProduct, fakeWorkspace } from "./protocol/fakes.harness"
import { memoryStore } from "./protocol/memory.fixture"

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
              admitAuthorizedRun: () =>
                Effect.fail(HostedProductError.make({ kind: "unavailable", message: "temporarily unavailable" })),
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
        },
      }

      expect((yield* Effect.exit(execute(admitted, "claim-1").pipe(Effect.provide(services))))._tag).toBe("Failure")
      expect(releases).toBe(0)
    }),
  ),
)
