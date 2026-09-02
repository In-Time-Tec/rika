import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref } from "effect"
import { CommandId, IdempotencyKey, RequestId, ThreadVersion } from "@rika/product/hosted-model"
import { protocolVersion, type WorkspacePlacement } from "@rika/product/client-protocol"
import { TurnId } from "@rika/product/turn-record"
import {
  HostedThreadProtocol,
  HostedThreadProtocolError,
  layerWithOptions as hostedThreadProtocolLayerWithOptions,
} from "../../../../../src/hosted/thread/protocol"
import { makeHostedPreviewBus } from "../../../../../src/hosted/thread/previews"
import { threadId } from "../memory.fixture"
import { makeSessionFixture } from "../session.fixture"

it.effect("reports prompt workspace readiness before wake and omits non-Orb readiness", () => {
  const { store, notifications, dependencies } = makeSessionFixture()
  return Effect.scoped(
    Effect.gen(function* () {
      const previews = yield* makeHostedPreviewBus()
      const order = yield* Ref.make<ReadonlyArray<"placement" | "wake">>([])
      const placementUnavailable = yield* Ref.make(false)
      const placement = yield* Ref.make<WorkspacePlacement>({
        _tag: "OrbWorkspace",
        state: "unassigned",
        readiness: "fresh",
        generation: "0",
      })
      const workspacePlacement = Effect.fn("Test.workspacePlacement")(function* () {
        yield* Ref.update(order, (current) => [...current, "placement" as const])
        if (yield* Ref.get(placementUnavailable))
          return yield* HostedThreadProtocolError.make({
            kind: "unavailable",
            message: "placement unavailable",
          })
        return yield* Ref.get(placement)
      })
      const protocolLayer = hostedThreadProtocolLayerWithOptions({
        notifications,
        previews: previews.bus,
        wakeCommand: Ref.update(order, (current) => [...current, "wake" as const]),
        workspacePlacement,
      }).pipe(Layer.provide(dependencies))
      const protocol = Context.get(yield* Layer.build(protocolLayer), HostedThreadProtocol)
      const connection = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      const submit = {
        protocolVersion,
        requestId: RequestId.make("fresh-request"),
        command: {
          _tag: "SubmitPrompt" as const,
          threadId,
          commandId: CommandId.make("fresh-command"),
          idempotencyKey: IdempotencyKey.make("fresh-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          text: "first Orb prompt",
        },
      }

      expect((yield* connection.receive(submit))[0]?.payload).toMatchObject({
        _tag: "CommandAdmitted",
        threadVersion: "1",
        workspace: { _tag: "OrbWorkspace", readiness: "fresh" },
      })
      expect(yield* Ref.get(order)).toEqual(["placement", "wake"])

      yield* Ref.set(order, [])
      expect(
        (yield* connection.receive({ ...submit, requestId: RequestId.make("fresh-retry") }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandAdmitted",
        threadVersion: "1",
        workspace: { _tag: "OrbWorkspace", readiness: "fresh" },
      })
      expect(yield* Ref.get(order)).toEqual(["placement"])

      yield* Ref.set(placement, { _tag: "RunnerWorkspace", state: "ready" })
      yield* Ref.set(order, [])
      const runnerPrompt = (yield* connection.receive({
        ...submit,
        requestId: RequestId.make("runner-request"),
        command: {
          ...submit.command,
          commandId: CommandId.make("runner-command"),
          idempotencyKey: IdempotencyKey.make("runner-key"),
          expectedThreadVersion: ThreadVersion.make("1"),
        },
      }))[0]?.payload
      expect(runnerPrompt).toMatchObject({ _tag: "CommandAdmitted", threadVersion: "2" })
      expect(runnerPrompt).not.toHaveProperty("workspace")
      expect(yield* Ref.get(order)).toEqual(["placement", "wake"])

      yield* Ref.set(order, [])
      const cancellation = (yield* connection.receive({
        protocolVersion,
        requestId: RequestId.make("cancel-request"),
        command: {
          _tag: "Cancel",
          threadId,
          commandId: CommandId.make("cancel-command"),
          idempotencyKey: IdempotencyKey.make("cancel-key"),
          expectedThreadVersion: ThreadVersion.make("2"),
          target: { _tag: "Turn", turnId: TurnId.make("turn-1") },
        },
      }))[0]?.payload
      expect(cancellation).toMatchObject({ _tag: "CommandAdmitted", threadVersion: "3" })
      expect(cancellation).not.toHaveProperty("workspace")
      expect(yield* Ref.get(order)).toEqual(["wake"])

      yield* Ref.set(placementUnavailable, true)
      yield* Ref.set(order, [])
      const rejected = yield* connection.receive({
        ...submit,
        requestId: RequestId.make("failed-placement-request"),
        command: {
          ...submit.command,
          commandId: CommandId.make("failed-placement-command"),
          idempotencyKey: IdempotencyKey.make("failed-placement-key"),
          expectedThreadVersion: ThreadVersion.make("3"),
        },
      })
      expect(rejected[0]?.payload).toMatchObject({ _tag: "CommandRejected", reason: "unavailable" })
      expect(store.command("failed-placement-command")).toBeUndefined()
      expect(yield* Ref.get(order)).toEqual(["placement"])
    }),
  )
})
