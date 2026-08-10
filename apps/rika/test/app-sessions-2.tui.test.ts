import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "keeps nested Agent prompts, tools, and final output aligned through collapse and expand",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "nested.txt": "NESTED_TOOL_CONTENT" },
          /**
           * One level of delegation, so the child does its own work in its own cell rather than
           * delegating again: a deeper chain holds every slot the scheduler has and never finishes.
           */
          lanes: [
            {
              steps: [
                model.turn([model.spawnAndWait([{ profile: "Task", prompt: "PARENT_AGENT_PROMPT" }], "parent-agent")]),
                model.text("ROOT_AGENT_FINAL"),
              ],
            },
            {
              profile: "Task",
              steps: [
                model.turn([
                  model.binding(
                    { module: "workspace", operation: "read", input: { path: "nested.txt" } },
                    "nested-read",
                  ),
                ]),
                model.text("PARENT_AGENT_FINAL"),
              ],
            },
          ],
          width: 80,
          height: 64,
        })

        yield* Effect.promise(() => app.type("ROOT_USER_PROMPT"))
        app.pressEnter()
        yield* app.waitFrame("ROOT_AGENT_FINAL")
        yield* app.settled

        const durable = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        const units = durable?.units ?? []
        const card = (name: string) =>
          units.find(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "SubagentCard" &&
              unit.content.block.name === name,
          )
        const parentCard = card("Task")
        const parentId =
          parentCard?.content._tag === "Block" && parentCard.content.block._tag === "SubagentCard"
            ? parentCard.content.block.id
            : undefined
        expect(parentId, "parent SubagentCard").toBeDefined()
        const cardUnit = (childId: string | undefined) =>
          units.find(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "SubagentCard" &&
              unit.content.block.id === childId,
          )
        const cellOwning = (childId: string | undefined) =>
          units.find(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "Cell" &&
              unit.content.block.id === cardUnit(childId)?.parentId,
          )
        expect(cellOwning(parentId), "the root cell that spawned Task").toBeDefined()
        const owner = (text: string) =>
          units.find((unit) => unit.content._tag === "Entry" && unit.content.text.includes(text))?.parentId
        expect(owner("PARENT_AGENT_FINAL")).toBe(parentId)
        expect(owner("ROOT_AGENT_FINAL")).toBeUndefined()
        const nestedReadCell = units.find(
          (unit) =>
            unit.content._tag === "Block" &&
            unit.content.block._tag === "Cell" &&
            unit.content.block.source.text.includes("nested.txt"),
        )
        expect(nestedReadCell?.parentId).toBe(parentId)

        // The spawning cell is the first expandable row now, so the card is one Tab further on.
        app.pressKey("\t")
        app.pressKey("\t")
        app.pressEnter()
        const expanded = yield* app.waitFrame("PARENT_AGENT_PROMPT")
        expect(expanded).toContain("PARENT_AGENT_FINAL")
        expect(expanded.match(/ROOT_USER_PROMPT/g) ?? []).toHaveLength(1)
        expect(expanded.match(/PARENT_AGENT_PROMPT/g) ?? []).toHaveLength(1)
        app.pressEnter()
        const collapsed = yield* app.waitGone("PARENT_AGENT_PROMPT")
        expect(collapsed).toContain("ROOT_AGENT_FINAL")
        app.pressEnter()
        const reexpanded = yield* app.waitFrame("PARENT_AGENT_PROMPT")
        expect(reexpanded.match(/PARENT_AGENT_PROMPT/g) ?? []).toHaveLength(1)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
