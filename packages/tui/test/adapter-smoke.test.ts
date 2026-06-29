import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Option, Queue } from "effect"
import { Adapter, ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_adapter_smoke")
const turnId = Ids.TurnId.make("turn_adapter_smoke")

describe("adapter Surface (headless)", () => {
  test("renders the welcome surface and an active transcript", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)

      surface.update(ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep" }))
      await setup.renderOnce()
      const welcome = setup.captureCharFrame()
      expect(welcome).toContain("Welcome to Amp")
      expect(welcome).toContain("deep³")
      expect(welcome).not.toContain("$0.00")
      expect(setup.captureCharFrame()).not.toContain("(main)")

      surface.update(
        ViewState.withGitBranch(
          ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep" }),
          "main",
        ),
      )
      await setup.renderOnce()
      const welcomeWithBranch = setup.captureCharFrame()
      expect(welcomeWithBranch).toContain("/workspace/rika (main)")

      const active = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "smart",
        events: [messageAdded(1, "user", "write a haiku"), messageAdded(2, "assistant", "snow on the cedar")],
      })
      surface.update(active)
      await setup.renderOnce()
      const transcript = setup.captureCharFrame()
      expect(transcript).toContain("write a haiku")
      expect(transcript).toContain("snow on the cedar")
      expect(transcript).toContain("smart")
      expect(transcript).not.toContain("smart²")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("input border cutouts inherit the renderer background", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 })
    try {
      setup.renderer.setBackgroundColor("#101010")
      const surface = new Adapter.Surface(setup.renderer)
      const active = ViewState.queueUp(
        ViewState.enqueueMessage(
          ViewState.withGitBranch(
            ViewState.initial({
              thread_id: threadId,
              workspace_path: "/Users/dallen.pyrah/projects/rika",
              mode: "smart",
              events: [turnStarted(1)],
            }),
            "main",
          ),
          "queued prompt",
        ),
      )

      surface.update(active)
      await setup.renderOnce()

      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      const expectBackground = (text: string) => {
        const span = spans.find((candidate) => candidate.text === text)
        expect(span).toBeDefined()
        expect(span?.bg.toInts().slice(0, 3)).toEqual([16, 16, 16])
      }

      expectBackground("enter to steer · backspace to dequeue")
      expectBackground("smart")
      expectBackground("Thinking…")
      expectBackground("~/projects/rika (main)")

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain("─Thinking")
      expect(frame).not.toContain("rika─(main)")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("clicking expandable transcript rows emits semantic UI actions", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 })
    try {
      const actions = Effect.runSync(Queue.unbounded<Adapter.Action>())
      const surface = new Adapter.Surface(setup.renderer, actions)

      const single = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "smart",
        events: [toolRequested(1, "tool_single"), toolCompleted(2, "tool_single")],
      })
      surface.update(single)
      await setup.renderOnce()
      await clickLine(setup, "Write a.ts")
      expect(Effect.runSync(Queue.poll(actions).pipe(Effect.map(Option.getOrUndefined)))).toEqual({
        _tag: "ToggleCard",
        card_id: "tool_single",
      })

      const grouped = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "smart",
        events: [
          toolRequested(3, "tool_group_a"),
          toolCompleted(4, "tool_group_a"),
          toolRequested(5, "tool_group_b"),
          toolCompleted(6, "tool_group_b"),
        ],
      })
      surface.update(grouped)
      await setup.renderOnce()
      await clickLine(setup, "Edited 2 files")
      expect(Effect.runSync(Queue.poll(actions).pipe(Effect.map(Option.getOrUndefined)))).toEqual({
        _tag: "ToggleToolGroup",
      })
    } finally {
      setup.renderer.destroy()
    }
  })

  test("read rows render without expansion arrows while command rows expand", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 })
    try {
      const actions = Effect.runSync(Queue.unbounded<Adapter.Action>())
      const surface = new Adapter.Surface(setup.renderer, actions)
      const state = ViewState.toggleToolGroup(
        ViewState.initial({
          thread_id: threadId,
          workspace_path: "/workspace/rika",
          mode: "smart",
          events: [
            toolRequested(1, "read_agents", "read", { path: "AGENTS.md" }),
            toolCompleted(2, "read_agents", "read", { path: "AGENTS.md", content: "hidden" }),
            toolRequested(3, "run_tests", "bash", { command: "bun test packages/tui" }),
            toolCompleted(4, "run_tests", "bash", { stdout: "56 pass\n", stderr: "", exit_code: 0 }),
          ],
        }),
      )

      surface.update(state)
      await setup.renderOnce()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("Read AGENTS.md")
      expect(frame).not.toContain("Read AGENTS.md ▸")
      expect(frame).not.toContain("Read AGENTS.md ▾")
      expect(frame).toContain("$ bun test packages/tui ▸")

      await clickLine(setup, "$ bun test packages/tui")
      expect(Effect.runSync(Queue.poll(actions).pipe(Effect.map(Option.getOrUndefined)))).toEqual({
        _tag: "ToggleCard",
        card_id: "run_tests",
      })
    } finally {
      setup.renderer.destroy()
    }
  })
})

const base = (sequence: number): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_adapter_smoke_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const messageAdded = (sequence: number, role: Message.Role, content: string): Event.MessageAdded => ({
  ...base(sequence),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_adapter_smoke_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(content)],
      created_at: Common.TimestampMillis.make(sequence),
    },
  },
})

const turnStarted = (sequence: number): Event.TurnStarted => ({
  ...base(sequence),
  turn_id: turnId,
  type: "turn.started",
  data: {},
})

const toolRequested = (
  sequence: number,
  id: string,
  name = "write",
  input: Common.JsonValue = { path: "a.ts" },
): Event.ToolCallRequested => ({
  ...base(sequence),
  type: "tool.call.requested",
  data: { call: { id: Ids.ToolCallId.make(id), name, input } },
})

const toolCompleted = (
  sequence: number,
  id: string,
  name = "write",
  output: Common.JsonValue = { ok: true },
): Event.ToolCallCompleted => ({
  ...base(sequence),
  type: "tool.call.completed",
  data: {
    result: { id: Ids.ToolCallId.make(id), name, status: "success", output },
  },
})

const clickLine = async (setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string): Promise<void> => {
  const lines = setup.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = Math.max(1, lines[y]?.indexOf(text) ?? 1)
  await setup.mockMouse.click(x, y)
  await setup.renderOnce()
}
