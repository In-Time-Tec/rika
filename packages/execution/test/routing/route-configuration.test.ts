import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect"
import { Runtime, RunTree } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as Gateway from "@rika/product/execution-gateway"
import { layerMemory, remoteTools } from "../../src/engine/runtime"
import * as RemoteTools from "../../src/remote-tools"
import { laneExecutionRoute, makeLaneModels, step, type LaneModels } from "../../src/test-harness"

const awaitRootRequests = (models: LaneModels, count: number) =>
  models.requestsFor("Root").pipe(
    Effect.filterOrFail((requests) => requests.length >= count),
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
  )

for (const explicitAwait of [true, false])
  it.live(`runs independent parent work with explicit child wait ${explicitAwait}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const awaitParameters = { groupId: "pending-group-id" }
        const parentCanFinish = yield* Deferred.make<void>()
        const childCanFinish = yield* Deferred.make<void>()
        const models = yield* makeLaneModels([
          {
            profile: "Root",
            steps: [
              TestModel.turn([
                TestModel.toolCall(
                  "start_child_group",
                  {
                    members: [{ key: "held", selection: "Task", prompt: "stay open, then finish" }],
                    concurrency: 1,
                  },
                  { id: "start-group" },
                ),
              ]),
              step.turn([step.read({ path: "README.md" }, "parent-read")]),
              ...(explicitAwait
                ? [TestModel.turn([TestModel.toolCall("await_child_group", awaitParameters, { id: "await-group" })])]
                : []),
              step.text("parent complete"),
            ],
          },
          {
            profile: "Task",
            steps: [step.turn([step.read({ path: "child-held" }, "child-read")]), step.text("child complete")],
          },
        ])
        const remoteCalls: Array<RemoteTools.Request> = []
        const context = yield* Layer.build(
          layerMemory({
            modelServices: models.registryLayer,
            tools: remoteTools({
              admit: () => Effect.void,
              tools: RemoteTools.layer({
                execute: (request) =>
                  Effect.gen(function* () {
                    remoteCalls.push(request)
                    yield* Deferred.await(
                      request.request._tag === "Read" && request.request.path === "child-held"
                        ? childCanFinish
                        : parentCanFinish,
                    )
                    return { _tag: "Success" as const, result: { text: "README contents", truncated: false } }
                  }),
                cancel: () => Effect.succeed({ _tag: "Cancelled" as const }),
              }),
            }),
          }),
        )
        const gateway = Context.get(context, Gateway.Service)
        const runtime = Context.get(context, Runtime.Runtime)
        const link = yield* gateway.startTurn({
          threadId: "child-group-runtime-thread",
          turnId: "child-group-runtime-turn",
          workspaceId: "workspace",
          prompt: "delegate and keep working",
          executionRoute: laneExecutionRoute(),
        })
        const watch = yield* gateway
          .watchTurn(link, { prompt: "delegate and keep working" })
          .pipe(Stream.runDrain, Effect.forkScoped)

        const firstTwo = yield* awaitRootRequests(models, 2)
        const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
        const exposedTools = yield* encodeJson(firstTwo[0]!.tools)
        expect(exposedTools).toContain('"name":"start_child_group"')
        expect(exposedTools).toContain('"name":"await_child_group"')
        const receiptPrompt = yield* encodeJson(firstTwo[1]!.prompt)
        const groupId = receiptPrompt.match(/fanout_[A-Za-z0-9_-]+/)?.[0]
        expect(groupId).toBeTruthy()
        awaitParameters.groupId = groupId!
        yield* Deferred.succeed(parentCanFinish, undefined)

        const whileParentWorks = yield* RunTree.checkpoint(link.runId).pipe(
          Effect.provideService(Runtime.Runtime, runtime),
        )
        expect(whileParentWorks.inspection._tag).toBe("Active")
        expect(
          whileParentWorks.inspection.runs.some(({ run }) => run.runId !== link.runId && run.status !== "succeeded"),
        ).toBe(true)

        yield* awaitRootRequests(models, 3)
        yield* Effect.sleep("50 millis")
        expect(yield* models.requestCountFor("Root")).toBe(3)
        expect(remoteCalls.some((request) => request.toolCallId === "parent-read")).toBe(true)
        const whileAwaiting = yield* RunTree.checkpoint(link.runId).pipe(
          Effect.provideService(Runtime.Runtime, runtime),
        )
        expect(whileAwaiting.inspection._tag).toBe("Active")
        if (!explicitAwait) {
          const waitingRoot = yield* RunTree.checkpoint(link.runId).pipe(
            Effect.provideService(Runtime.Runtime, runtime),
            Effect.filterOrFail((checkpoint) =>
              checkpoint.inspection.runs.some(({ run }) => run.runId === link.runId && run.status === "waiting"),
            ),
            Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
          )
          // Generalist defers the root outcome until its group settles, without
          // preventing the parent model from producing its final answer first.
          expect(waitingRoot.inspection._tag).toBe("Active")
          expect((yield* gateway.inspectTurn(link)).status).toBe("waiting")
          expect(watch.pollUnsafe()).toBeUndefined()
        }

        yield* Deferred.succeed(childCanFinish, undefined)
        yield* Fiber.join(watch)
        expect(yield* models.requestCountFor("Root")).toBe(explicitAwait ? 4 : 3)
        expect(yield* models.requestCountFor("Task")).toBe(2)
        expect(
          (yield* RunTree.checkpoint(link.runId).pipe(Effect.provideService(Runtime.Runtime, runtime))).inspection._tag,
        ).toBe("Terminal")
      }),
    ),
  )
