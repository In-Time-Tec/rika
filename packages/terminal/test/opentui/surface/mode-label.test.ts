import { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { buildTranscript } from "../../../src/opentui/rendering/renderer"
import { Surface } from "../../../src/opentui/surface/service"
import { adapterFixtures4 } from "../../state/loadable.fixture"
import { openTui } from "../../support/surface/transcript/pane-geometry.fixture"
const {
  shell,
  _windowUnitToolCall,
  _agentToolBlock,
  handlers,
  nonEmptyLines,
  subagentToolBlock,
  renderedText,
  model,
  _thread,
} = adapterFixtures4
test("keeps wrapped response continuations inside the rail and curls the final row", () => {
  const state = model({
    width: 60,
    entries: [
      {
        role: "assistant",
        text: "1. Splitting the server endpoint into separate host and client transports removes the restart complexity.",
        turnId: "child:agent",
      },
    ],
    blocks: [{ ...subagentToolBlock, detail: "Inspect the projection" }, shell("child-a", "bun test", "passed")],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-a", turnId: "child:agent", parentId: "agent" },
      { _tag: "Entry", index: 0, id: "assistant:child:agent:0", turnId: "child:agent", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const lines = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
    .split("\n")
  const first = lines.findIndex((line) => line.includes("Splitting"))
  const continuation = lines.findIndex((line) => line.includes("complexity"))
  expect(first).toBeGreaterThan(-1)
  expect(continuation).toBeGreaterThan(first)
  const responseRows = lines.slice(first, continuation + 1)
  expect(responseRows.length).toBeGreaterThan(1)
  for (const row of responseRows.slice(0, -1)) expect(row.startsWith("  │   ")).toBe(true)
  expect(responseRows[responseRows.length - 1]!.startsWith("  ╰   ")).toBe(true)
  for (const row of responseRows) expect(row.length).toBeLessThanOrEqual(60)
})
test("expands a failed subagent to its prompt and stored error text", () => {
  const lines = nonEmptyLines(
    renderedText({
      blocks: [
        {
          ...subagentToolBlock,
          status: "failed",
          detail: "Inspect the projection",
          output: "AgentToolError: Model gpt-5.6-luna is not available",
        },
      ],
      expandedRowKeys: ["tool:agent"],
    }),
  )
  expect(lines.some((line) => line.includes("Inspect the projection"))).toBe(true)
  expect(lines.some((line) => line.includes("AgentToolError: Model gpt-5.6-luna is not available"))).toBe(true)
  expect(lines.filter((line) => line.includes("AgentToolError: Model gpt-5.6-luna is not available"))).toHaveLength(1)
})
test("renders a finished subagent response as markdown inside the expanded unit", () => {
  const state = model({
    entries: [{ role: "assistant", text: "**Child result**\n\n**Checks passed.**", turnId: "child" }],
    blocks: [
      {
        _tag: "ToolCall",
        id: "oracle",
        name: "oracle",
        input: JSON.stringify({ prompt: "Review the code" }),
        status: "complete",
        presentation: {
          family: "agent",
          action: "oracle",
          activeLabel: "Oracle exploring",
          completeLabel: "Oracle has spoken",
        },
        detail: "Review the code",
        files: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:oracle", turnId: "turn" },
      { _tag: "Entry", index: 0, id: "assistant:child:0", turnId: "child", parentId: "oracle" },
    ],
    expandedRowKeys: ["tool:oracle"],
  })

  const text = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

  expect(text).toContain("Oracle has spoken ▾")
  expect(text).toContain("Review the code")
  expect(text).toContain("Child result")
  expect(text).toContain("Checks passed.")
  expect(text).not.toContain("**")
})
test("never renders a serialized child result as subagent output", () => {
  const serialized =
    '{"status":"completed","output":[{"type":"text","text":"## Child result\\n\\n**Checks passed.**"}]}'
  const state = model({
    blocks: [
      {
        _tag: "ToolCall",
        id: "task",
        name: "task",
        input: "{}",
        output: serialized,
        status: "complete",
        presentation: {
          family: "agent",
          action: "task",
          activeLabel: "Subagent working",
          completeLabel: "Subagent finished",
        },
        detail: "",
        files: [],
      },
    ],
    expandedRowKeys: ["tool:task"],
  })
  const text = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

  expect(text).toContain("Subagent finished")
  expect(text).not.toContain("\\n")
  expect(text).not.toContain('"}]}')
  expect(text).not.toContain(serialized)
})
test("presents successful and failed shell commands with expandable output", () => {
  const command = (status: "complete" | "failed", output: string) =>
    buildTranscript(
      model({
        blocks: [
          {
            _tag: "ToolCall",
            id: "git-status",
            name: "bash",
            input: '{"command":"git --no-optional-locks status --short --branch"}',
            output,
            status,
            presentation: { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
            detail: "git --no-optional-locks status --short --branch",
            files: [],
          },
        ],
        expandedRowKeys: ["tool:git-status"],
      }),
    )
      .styled.chunks.map((chunk) => chunk.text)
      .join("")
  const successful = command("complete", "## inspection\nM  staged.ts")
  const failed = command("failed", "fatal: not a git repository")
  expect(successful).toContain("$ git --no-optional-locks status --short --branch")
  expect(successful).toContain("## inspection")
  expect(failed).toContain("fatal: not a git repository")
})
test("uses the child profile activity label with a Subagent fallback", () => {
  const rendered = buildTranscript(
    model({
      blocks: [
        {
          _tag: "SubagentCard",
          id: "oracle",
          name: "oracle",
          prompt: "",
          promptTruncated: false,
          summary: "",
          status: "running",
          activity: [],
        },
        {
          _tag: "SubagentCard",
          id: "task",
          name: "task",
          prompt: "",
          promptTruncated: false,
          summary: "",
          status: "running",
          activity: [],
        },
      ],
    }),
  )
  const text = rendered.styled.chunks.map((chunk) => chunk.text).join("")

  expect(text).toContain("Oracle exploring")
  expect(text).toContain("Subagent working")
  expect(text).not.toContain("Task working")
})
it.effect("constructs the render tree and forwards key and resize events", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
    const surface = new Surface(setup.renderer, callbacks)

    expect(setup.renderer.root.getChildren()).toEqual([
      surface.main,
      surface.modeLabel,
      surface.statusLabel,
      surface.goalLabel,
      surface.workspaceLabel,
      surface.paletteBox,
      surface.overlayHintOne,
      surface.overlayHintTwo,
      surface.toastBox,
      surface.ctrlCMenuBox,
      surface.ctrlCMenuTitle,
    ])
    expect(surface.inputBox.getChildren()).toContain(surface.input)
    expect(surface.paletteBox.getChildren()).toContain(surface.palette)
    expect(surface.changedFilesBox.content.getChildren()).toContain(surface.changedFilesText)
    expect(surface.main.getChildren()).toContain(surface.contentColumn)
    expect(surface.contentColumn.getChildren()).toContain(surface.inputBox)
    expect(surface.changedFilesBox).toBeInstanceOf(ScrollBoxRenderable)

    setup.renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name: "o",
        ctrl: true,
        option: true,
        meta: false,
        shift: true,
        sequence: "o",
        number: false,
        raw: "o",
        eventType: "repeat",
        source: "kitty",
        super: false,
      }),
    )
    setup.resize(101, 37)

    expect(callbacks.key).toHaveBeenLastCalledWith({
      name: "o",
      ctrl: true,
      alt: true,
      meta: false,
      shift: true,
      sequence: "o",
      eventType: "repeat",
    })
    expect(callbacks.resize).toHaveBeenLastCalledWith(101, 37)
    surface.destroy()
    setup.renderer.destroy()
  }),
)
