import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const childTools = ["run_child", "run_child_group", "typescript"]
const leafTools = ["typescript"]

test.each([
  { name: "zero depth", subagents: { maxDepth: 0, maxSubagents: 4 } },
  { name: "zero direct-child quota", subagents: { maxDepth: 4, maxSubagents: 0 } },
])("gives the root only ordinary tools at $name", ({ subagents }) =>
  TuiApp.run(
    Effect.gen(function* () {
      const app = yield* TuiApp.tuiApp({ script: [model.text("ROOT_LEAF_DONE")], subagents })
      yield* Effect.promise(() => app.type("Inspect the root tool surface."))
      app.pressEnter()
      yield* app.waitFrame("ROOT_LEAF_DONE")
      yield* app.settled
      expect(yield* app.modelToolNamesFor("Root")).toEqual([leafTools])
      yield* app.quit
    }),
  ),
)

test("makes depth one a leaf while keeping the root child-capable", () =>
  TuiApp.run(
    Effect.gen(function* () {
      const app = yield* TuiApp.tuiApp({
        subagents: { maxDepth: 1, maxSubagents: 4 },
        lanes: [
          {
            steps: [
              model.turn([model.spawn([{ profile: "Task", prompt: "DEPTH_ONE_CHILD" }], "depth-one")]),
              model.text("DEPTH_ONE_ROOT_DONE"),
            ],
          },
          { profile: "Task", steps: [model.text("DEPTH_ONE_CHILD_DONE")] },
        ],
      })
      yield* Effect.promise(() => app.type("Delegate at depth one."))
      app.pressEnter()
      yield* app.waitFrame("DEPTH_ONE_ROOT_DONE", 20_000)
      yield* app.settled
      expect((yield* app.modelToolNamesFor("Root"))[0]).toEqual(childTools)
      expect(yield* app.modelToolNamesFor("Task")).toEqual([leafTools])
      yield* app.quit
    }),
  ))

test("keeps depth one child-capable and makes depth two a leaf", () =>
  TuiApp.run(
    Effect.gen(function* () {
      const app = yield* TuiApp.tuiApp({
        subagents: { maxDepth: 2, maxSubagents: 4 },
        lanes: [
          {
            steps: [
              model.turn([model.spawn([{ profile: "Task", prompt: "DEPTH_ONE" }], "root-child")]),
              model.text("DEPTH_TWO_ROOT_DONE"),
            ],
          },
          {
            profile: "Task",
            steps: [
              model.turn([model.spawn([{ profile: "Oracle", prompt: "DEPTH_TWO" }], "child-child")]),
              model.text("DEPTH_ONE_DONE"),
            ],
          },
          { profile: "Oracle", steps: [model.text("DEPTH_TWO_DONE")] },
        ],
      })
      yield* Effect.promise(() => app.type("Delegate through depth two."))
      app.pressEnter()
      yield* app.waitFrame("DEPTH_TWO_ROOT_DONE", 20_000)
      yield* app.settled
      expect((yield* app.modelToolNamesFor("Root"))[0]).toEqual(childTools)
      expect((yield* app.modelToolNamesFor("Task"))[0]).toEqual(childTools)
      expect(yield* app.modelToolNamesFor("Oracle")).toEqual([leafTools])
      yield* app.quit
    }),
  ))

test("removes child tools from a parent after its lifetime quota is exhausted", () =>
  TuiApp.run(
    Effect.gen(function* () {
      const app = yield* TuiApp.tuiApp({
        subagents: { maxDepth: 4, maxSubagents: 1 },
        lanes: [
          {
            steps: [
              model.turn([model.spawn([{ profile: "Task", prompt: "ONLY_CHILD" }], "only-child")]),
              model.text("QUOTA_ROOT_DONE"),
            ],
          },
          { profile: "Task", steps: [model.text("ONLY_CHILD_DONE")] },
        ],
      })
      yield* Effect.promise(() => app.type("Use the only direct-child slot."))
      app.pressEnter()
      yield* app.waitFrame("QUOTA_ROOT_DONE", 20_000)
      yield* app.settled
      expect(yield* app.modelToolNamesFor("Root")).toEqual([childTools, leafTools])
      yield* app.quit
    }),
  ))
