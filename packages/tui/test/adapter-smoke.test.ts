import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Common, Event, Ids, Message } from "@rika/schema"
import { parseDiffFromFile, type FileContents } from "@pierre/diffs"
import { Effect, Option, Queue } from "effect"
import { DiffRenderCache } from "../src/diff-renderer"
import { Adapter, ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_adapter_smoke")
const turnId = Ids.TurnId.make("turn_adapter_smoke")

describe("adapter Surface (headless)", () => {
  test("renders the welcome surface and an active transcript", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)

      surface.update(ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" }))
      await setup.renderOnce()
      const welcome = setup.captureCharFrame()
      expect(welcome).toContain("Welcome to Amp")
      expect(welcome).toContain("deep³")
      expect(welcome).not.toContain("$0.00")
      expect(setup.captureCharFrame()).not.toContain("(main)")

      surface.update(
        ViewState.withGitBranch(
          ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" }),
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

  test("renders orb lifecycle palette commands only for an active orb-backed thread", async () => {
    const setup = await createTestRenderer({ width: 120, height: 36 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const activeNonOrb = ViewState.paletteInsert(
        ViewState.openPalette(
          ViewState.initial({
            thread_id: threadId,
            workspace_path: "/workspace/rika",
            mode: "smart",
            events: [messageAdded(1, "user", "existing transcript")],
          }),
        ),
        "orb",
      )

      surface.update(activeNonOrb)
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      expect(frame).toContain("toggle")
      expect(frame).not.toContain("pause")
      expect(frame).not.toContain("resume")
      expect(frame).not.toContain("kill")

      const activeOrb = ViewState.paletteInsert(
        ViewState.openPalette(
          ViewState.withActiveOrb(
            ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "smart" }),
            { orb_id: Ids.OrbId.make("orb_adapter_smoke"), status: "running" },
          ),
        ),
        "orb",
      )

      surface.update(activeOrb)
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      expect(frame).toContain("toggle")
      expect(frame).toContain("pause")
      expect(frame).toContain("resume")
      expect(frame).toContain("kill")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("linkifies bare URLs and markdown links in assistant messages", async () => {
    const setup = await createTestRenderer({ width: 160, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "smart",
        events: [
          messageAdded(
            1,
            "assistant",
            "See https://github.com/In-Time-Tec/relay and [ci #123](https://ci.example.com/123).",
          ),
        ],
      })

      surface.update(state)
      await setup.renderOnce()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("https://github.com/In-Time-Tec/relay")
      expect(frame).toContain("ci #123")
      expect(frame).not.toContain("[ci #123]")
      expect(frame).not.toContain("ci.example.com")

      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expectSpanColor(spans, "https://github.com/In-Time-Tec/relay", [45, 212, 191])
      expectSpanColor(spans, "ci #123", [45, 212, 191])
      expectSpanUnderline(spans, "https://github.com/In-Time-Tec/relay")
      expectSpanUnderline(spans, "ci #123")
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
              workspace_path: `${process.env.HOME ?? "/root"}/projects/rika`,
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

      expectBackground("Enter")
      expectBackground(" to steer · ")
      expectBackground("Backspace")
      expectBackground(" to dequeue")
      expectBackground("smart")
      expectBackground("Thinking")
      expectBackground("~/projects/rika (main)")

      const frame = setup.captureCharFrame()
      expect(frame).toContain("Enter to steer")
      expect(frame).not.toContain("─Thinking")
      expect(frame).not.toContain("rika─(main)")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("armed orb-backed thread creation renders an orb status indicator", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.toggleRemoteArm(
        ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "smart" }),
      )

      surface.update(state)
      await setup.renderOnce()

      expect(setup.captureCharFrame()).toContain("[orb]")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("unselected queued prompts show only the steer hint", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.enqueueMessage(
        ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" }),
        "queued prompt",
      )

      surface.update(state)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()

      expect(frame).toContain("Enter to steer")
      expect(frame).not.toContain("Backspace to dequeue")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("queued prompts render in a separate stack above the live input", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.enqueueMessage(
        ViewState.enqueueMessage(
          ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" }),
          "first queued",
        ),
        "second queued",
      )

      surface.update(state)
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split("\n")
      const queueTop = lines.findIndex((line) => line.includes("Enter to steer"))
      const first = lines.findIndex((line) => line.includes("first queued"))
      const second = lines.findIndex((line) => line.includes("second queued"))
      const inputTop = lines.findIndex((line, index) => index > second && line.includes("deep³"))

      expect(queueTop).toBeGreaterThanOrEqual(0)
      expect(first).toBeGreaterThan(queueTop)
      expect(second).toBeGreaterThan(first)
      expect(inputTop).toBeGreaterThan(second)
      expect(lines.slice(inputTop).join("\n")).not.toContain("first queued")
      expect(lines.slice(inputTop).join("\n")).not.toContain("second queued")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("low costs keep Amp-style precision near the mode label", async () => {
    const setup = await createTestRenderer({ width: 100, height: 16 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = {
        ...ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" }),
        cost_usd: 0.002,
      }

      surface.update(state)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()

      expect(frame).toContain("$0.002")
      expect(frame).not.toContain("$0.00 ")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("renders context usage near the mode label", async () => {
    const setup = await createTestRenderer({ width: 100, height: 16 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "deep3",
        context_tokens: 280_000,
        context_window: 400_000,
      })

      surface.update(state)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()

      expect(frame).toContain("ctx 70%")
      expect(frame).toContain("deep³")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("selected prior user messages render an edit frame without inline hints", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.navPrevMessage(
        ViewState.initial({
          thread_id: threadId,
          workspace_path: "/workspace/rika",
          mode: "deep3",
          events: [messageAdded(1, "user", "Hi"), messageAdded(2, "assistant", "Hi! What should we tackle?")],
        }),
      )

      surface.update(state)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()

      expect(frame).toContain("e to edit")
      expect(frame).not.toContain("tab to cycle")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("renders Amp-style live activity labels", async () => {
    const setup = await createTestRenderer({ width: 100, height: 20 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const liveText = "x".repeat(2000)
      const baseState = ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "smart" })

      surface.update({ ...baseState, active: true, activity: "thinking", generated_text_chars: liveText.length })
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      expect(frame).toContain("Thinking 500 tok")
      expect(frame).not.toContain("thinking 500 tok")

      surface.update({ ...baseState, active: true, activity: "streaming", generated_text_chars: liveText.length })
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      expect(frame).toContain("Streaming 500 tok")
      expect(frame).not.toContain("streaming 500 tok")

      surface.update({ ...baseState, active: true, activity: "running-tools", generated_text_chars: liveText.length })
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      expect(frame).toContain("Running tools")
      expect(frame).not.toContain("Running tools…")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("renders the switch thread overlay with list and preview panes", async () => {
    const setup = await createTestRenderer({ width: 160, height: 48 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.openThreadSwitcher(
        ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" }),
        [
          {
            thread_id: Ids.ThreadId.make("thread_switch_smoke"),
            title: "Rika terminal image drag-paste handling",
            preview: "Research OpenTUI and make image placeholders render correctly in Rika terminal input.",
            updated_label: "17h ago",
            archived: false,
            orb_status: "running",
            diff: { additions: 21, modifications: 8, deletions: 15 },
            preview_state: {
              status: "ready",
              state: ViewState.initial({
                thread_id: Ids.ThreadId.make("thread_switch_smoke"),
                workspace_path: "/workspace/rika",
                mode: "deep3",
                events: [
                  messageAdded(1, "user", "## Preview heading\nUse `code`"),
                  toolRequested(2, "switch_preview_read", "read", { path: "README.md" }),
                  toolCompleted(3, "switch_preview_read", "read", { path: "README.md", content: "hidden" }),
                ],
              }),
            },
          },
        ],
      )

      surface.update(state)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()

      expect(frame).toContain("Switch Thread")
      expect(frame).toContain("Thread Preview")
      expect(frame).toContain("Rika terminal im...")
      expect(frame).toContain("+21 ~8 -15")
      expect(frame).toContain("[orb:running]")
      expect(frame).toContain("Preview heading")
      expect(frame).toContain("Read README.md")
      expect(frame).toContain("Opt+W/Ctrl+T")
      expect(frame).not.toContain("tool_call")
      expect(frame).not.toContain("Active threads")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("clips long switch thread previews inside the preview pane", async () => {
    const setup = await createTestRenderer({ width: 160, height: 48 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const longPreview = Array.from({ length: 80 }, (_, index) => `preview overflow sentinel ${index}`).join("\n")
      const state = ViewState.openThreadSwitcher(
        ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "smart" }),
        [
          {
            thread_id: Ids.ThreadId.make("thread_switch_overflow"),
            title: "Overflow preview",
            preview: "Overflow preview",
            updated_label: "now",
            archived: false,
            preview_state: {
              status: "ready",
              state: ViewState.initial({
                thread_id: Ids.ThreadId.make("thread_switch_overflow"),
                workspace_path: "/workspace/rika",
                mode: "smart",
                events: [messageAdded(1, "assistant", longPreview)],
              }),
            },
          },
        ],
      )

      surface.update(state)
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split("\n")
      const footerLine = lines.findIndex((line) => line.includes("Opt+W/Ctrl+T"))

      expect(footerLine).toBeGreaterThan(0)
      expect(lines.slice(0, footerLine + 1).join("\n")).toContain("preview overflow sentinel 0")
      expect(lines.slice(footerLine + 1).join("\n")).not.toContain("preview overflow sentinel")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("long transcripts render the native OpenTUI scrollbar", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "deep3",
        events: Array.from({ length: 40 }, (_, index) =>
          messageAdded(index + 1, index % 2 === 0 ? "user" : "assistant", `transcript line ${index + 1}`),
        ),
      })

      surface.update(state)
      await setup.renderOnce()

      expect(setup.captureCharFrame()).toMatch(/[█▀▄]/)
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
          toolRequested(5, "tool_group_b", "write", { path: "b.ts" }),
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
      expect(frame).toMatch(/\$ bun test packages\/tui\s+▸/)

      await clickLine(setup, "$ bun test packages/tui")
      expect(Effect.runSync(Queue.poll(actions).pipe(Effect.map(Option.getOrUndefined)))).toEqual({
        _tag: "ToggleCard",
        card_id: "run_tests",
      })
    } finally {
      setup.renderer.destroy()
    }
  })

  test("tool rows use Amp-style hierarchy and path segments open files", async () => {
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
            toolRequested(1, "read_agents", "read", { path: "/workspace/rika/AGENTS.md" }),
            toolCompleted(2, "read_agents", "read", {
              path: "/workspace/rika/AGENTS.md",
              start_line: 3,
              end_line: 5,
              content: "hidden",
            }),
            toolRequested(3, "edit_readme", "edit", { path: "/workspace/rika/README.md" }),
            toolCompleted(4, "edit_readme", "edit", {
              path: "/workspace/rika/README.md",
              diff: pierreDiff("/workspace/rika/README.md"),
            }),
          ],
        }),
      )

      surface.update(state)
      await setup.renderOnce()

      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expectSpanColor(spans, " Explored", [201, 209, 217])
      expectSpanColor(spans, " 1 file", [125, 133, 144])
      expectSpanColor(spans, ", ", [92, 99, 112])
      expectSpanColor(spans, "Edited", [201, 209, 217])
      expectSpanColor(spans, "Read ", [125, 133, 144])
      expectSpanColor(spans, "Edited ", [125, 133, 144])
      expectSpanColor(spans, "AGENTS.md", [210, 162, 92])
      expectSpanColor(spans, "README.md", [210, 162, 92])
      expectSpanUnderline(spans, "AGENTS.md")
      expectSpanUnderline(spans, "README.md")

      await moveToText(setup, "AGENTS.md")
      expect(mousePointerStyle(setup)).toBe("pointer")
      await setup.mockMouse.moveTo(0, 0)
      await setup.renderOnce()
      expect(mousePointerStyle(setup)).toBe("default")

      await clickLine(setup, "AGENTS.md")
      expect(Effect.runSync(Queue.poll(actions).pipe(Effect.map(Option.getOrUndefined)))).toEqual({
        _tag: "OpenFile",
        path: "AGENTS.md",
        range: { start_line: 3, end_line: 5 },
      })
    } finally {
      setup.renderer.destroy()
    }
  })

  test("tool group summary counts reread files once", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)
      const state = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "smart",
        events: [
          toolRequested(1, "read_agents_a", "read", { path: "/workspace/rika/AGENTS.md" }),
          toolCompleted(2, "read_agents_a", "read", { path: "/workspace/rika/AGENTS.md", content: "hidden" }),
          toolRequested(3, "read_agents_b", "read", { path: "AGENTS.md" }),
          toolCompleted(4, "read_agents_b", "read", { path: "AGENTS.md", content: "hidden" }),
          toolRequested(5, "read_context", "read", { path: "CONTEXT.md" }),
          toolCompleted(6, "read_context", "read", { path: "CONTEXT.md", content: "hidden" }),
        ],
      })

      surface.update(state)
      await setup.renderOnce()

      expect(setup.captureCharFrame()).toContain("Explored 2 files")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("expanded edit diffs use Pierre colors for stats, markers, and syntax", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 })
    try {
      const diffRenderer = new DiffRenderCache()
      const surface = new Adapter.Surface(setup.renderer, undefined, diffRenderer)
      const state = ViewState.toggleCard(
        ViewState.initial({
          thread_id: threadId,
          workspace_path: "/workspace/rika",
          mode: "smart",
          events: [
            toolRequested(1, "edit_app", "edit", { path: "app.ts" }),
            toolCompleted(2, "edit_app", "edit", {
              path: "app.ts",
              diff: pierreDiff("app.ts"),
            }),
          ],
        }),
        "edit_app",
      )
      const content = state.cards.find((card) => card.id === "edit_app")?.content
      if (content?.kind === "pierre-diff") await Effect.runPromise(diffRenderer.ensure(content.file_diff))

      surface.update(state)
      await setup.renderOnce()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("Edited app.ts +1 -1")
      expect(frame).toContain("1 - const value = 1")
      expect(frame).toContain("1 + const value = 2")
      expect(frame).not.toContain("diff -- app.ts")
      expect(frame).not.toContain("@@")

      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expectSpanColor(spans, " +1", [152, 195, 121])
      expectSpanColor(spans, " -1", [224, 108, 117])
      expectSpanColor(spans, "+", [152, 195, 121])
      expectSpanColor(spans, "-", [224, 108, 117])
      expectSpanColor(spans, "const value = 1", [224, 108, 117])
      expectSpanColor(spans, "const value = 2", [152, 195, 121])
    } finally {
      setup.renderer.destroy()
    }
  })

  test("expanded grouped edit diffs are inset under the tool rows", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 })
    try {
      const diffRenderer = new DiffRenderCache()
      const surface = new Adapter.Surface(setup.renderer, undefined, diffRenderer)
      const state = ViewState.toggleCard(
        ViewState.toggleToolGroup(
          ViewState.initial({
            thread_id: threadId,
            workspace_path: "/workspace/rika",
            mode: "smart",
            events: [
              toolRequested(1, "read_agents", "read", { path: "AGENTS.md" }),
              toolCompleted(2, "read_agents", "read", { path: "AGENTS.md", content: "hidden" }),
              toolRequested(3, "edit_app", "edit", { path: "app.ts" }),
              toolCompleted(4, "edit_app", "edit", {
                path: "app.ts",
                diff: pierreDiff("app.ts"),
              }),
            ],
          }),
        ),
        "edit_app",
      )
      const content = state.cards.find((card) => card.id === "edit_app")?.content
      if (content?.kind === "pierre-diff") await Effect.runPromise(diffRenderer.ensure(content.file_diff))

      surface.update(state)
      await setup.renderOnce()

      const frame = setup.captureCharFrame()
      const diffLine = frame.split("\n").find((line) => line.includes("1 + const value = 2"))
      const leadingSpaces = diffLine?.match(/^ */)?.[0].length
      expect(leadingSpaces).toBeGreaterThanOrEqual(4)
      expect(leadingSpaces).toBeLessThanOrEqual(6)
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

const pierreDiff = (name: string): Common.JsonValue => {
  const fileDiff: Common.JsonValue = JSON.parse(
    JSON.stringify(
      parseDiffFromFile(
        fileContents(name, "const value = 1\n", "before"),
        fileContents(name, "const value = 2\n", "after"),
      ),
    ),
  )
  return { kind: "diff", renderer: "@pierre/diffs", collapsed: true, file_diff: fileDiff }
}

const fileContents = (name: string, contents: string, header: string): FileContents => ({
  name,
  contents,
  header,
  cacheKey: `${name}:${header}`,
})

const clickLine = async (setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string): Promise<void> => {
  const { x, y } = textPosition(setup, text)
  await setup.mockMouse.click(x, y)
  await setup.renderOnce()
}

const moveToText = async (setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string): Promise<void> => {
  const { x, y } = textPosition(setup, text)
  await setup.mockMouse.moveTo(x, y)
  await setup.renderOnce()
}

const textPosition = (
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  text: string,
): { readonly x: number; readonly y: number } => {
  const lines = setup.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = Math.max(1, (lines[y]?.indexOf(text) ?? 1) + Math.floor(text.length / 2))
  return { x, y }
}

const mousePointerStyle = (setup: Awaited<ReturnType<typeof createTestRenderer>>): unknown =>
  Reflect.get(setup.renderer, "_currentMousePointerStyle")

const expectSpanColor = (
  spans: ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>["lines"][number]["spans"],
  text: string,
  rgb: readonly [number, number, number],
): void => {
  const span = spans.find((candidate) => candidate.text === text)
  expect(span).toBeDefined()
  expect(span?.fg.toInts().slice(0, 3)).toEqual([...rgb])
}

const expectSpanUnderline = (
  spans: ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>["lines"][number]["spans"],
  text: string,
): void => {
  const span = spans.find((candidate) => candidate.text === text)
  expect(span).toBeDefined()
  expect((span?.attributes ?? 0) & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE)
}
