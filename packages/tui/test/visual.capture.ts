import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem, Path, Schema } from "effect"
import { Surface } from "../src/adapter"
import {
  initial,
  ready,
  replaceQueue,
  update,
  type Model,
  type ThreadItem,
  type TranscriptBlock,
} from "../src/view-state"

export const visualMetadata = {
  schema: 2,
  terminal: { columns: 80, rows: 24, emulator: "OpenTUI test renderer", font: "cell-grid" },
  theme: { name: "Rika dark", background: "inherited", foreground: "#c9d1d9", surface: "#161b22" },
  native: { opentui: "0.4.3", bun: "1.3.14" },
  masks: [] as Array<{ x: number; y: number; width: number; height: number }>,
  thresholds: { characterDifferences: 0, pixelChannelDelta: 0, differingPixelRatio: 0 },
  pixelModel:
    "deterministic cell raster from OpenTUI captured spans; character cells use foreground and blank cells use background",
  styleModel: "OpenTUI spans serialized as text, RGBA foreground/background, attributes, and cell width",
} as const

const block = (value: TranscriptBlock): Model => ({ ...initial("/workspace", "high"), blocks: [value] })
const tool = (
  id: string,
  name: string,
  detail: string,
  status: Extract<TranscriptBlock, { _tag: "ToolCall" }>["status"],
  output?: string,
): Extract<TranscriptBlock, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id,
  name,
  input: detail,
  status,
  presentation:
    name === "read" || name === "grep"
      ? {
          family: "explore",
          action: name === "grep" ? "grep" : "read",
          activeLabel: "Exploring",
          completeLabel: "Explored",
          counter: name === "grep" ? "search" : "file",
        }
      : { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
  detail,
  files: [],
  ...(output === undefined ? {} : { output }),
})
const base = (): Model => initial("/workspace", "high")
const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/workspace",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})
const threadBrowser = (): Model => ({
  ...base(),
  currentThreadId: "thread-1",
  threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
  threads: [
    thread({
      id: "thread-1",
      title: "Rika performance and reliability",
      unread: true,
      editTotals: { added: 428, modified: 56, removed: 59 },
    }),
    thread({
      id: "thread-2",
      title: "Push all local changes to main",
      status: "running",
      editTotals: { added: 558, modified: 68, removed: 68 },
    }),
    thread({ id: "thread-3", title: "TUI performance and bug audit", unread: true }),
  ],
  threadPreview: ready({
    threadId: "thread-1",
    turns: [
      {
        prompt: "Finish the thread UI parity work.",
        events: [
          {
            cursor: "preview-output",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 1,
            text: "Merged all work into main and verified the affected paths.",
          },
          { cursor: "preview-complete", sequence: 2, type: "execution.completed", createdAt: 2 },
        ],
      },
    ],
  }),
})

export const scenarios = (): ReadonlyArray<readonly [string, Model, number, number]> => {
  const reasoning = block({ _tag: "Reasoning", text: "Inspecting stable inputs" })
  const restarted = update(
    update(base(), {
      _tag: "EventReplayed",
      event: {
        id: "event-1",
        cursor: "cursor-1",
        block: { _tag: "Workflow", name: "restart", step: "resume", status: "running" },
      },
    }),
    {
      _tag: "EventReplayed",
      event: {
        id: "event-1",
        cursor: "cursor-1",
        block: { _tag: "Workflow", name: "restart", step: "resume", status: "running" },
      },
    },
  )
  return [
    ["welcome", base(), 80, 24],
    ["prompt", { ...base(), input: "Explain this repository", cursor: 23 }, 80, 24],
    [
      "streaming",
      { ...base(), busy: true, entries: [{ role: "assistant", text: "Streaming deterministic text…" }] },
      80,
      24,
    ],
    [
      "markdown",
      {
        ...base(),
        entries: [
          {
            role: "assistant",
            text: "# Styled Markdown\n\n**bold** and *emphasis* with `inline code`.\n\n| Layer | Owner |\n|---|---|\n| Durable execution | Relay |\n| Agent loop | Baton |\n\n> muted quote\n\n```ts\nconst answer = 42\n```",
          },
        ],
      },
      80,
      24,
    ],
    ["reasoning-collapsed", reasoning, 80, 24],
    ["reasoning-expanded", update(reasoning, { _tag: "ReasoningToggled", index: 0 }), 80, 24],
    ["tool", block(tool("tool-1", "read", "src/main.ts", "running")), 80, 24],
    [
      "tool-expanded",
      {
        ...block(tool("tool-1", "read", "src/main.ts", "complete", "contents")),
        expandedRowKeys: ["tool:tool-1"],
      },
      80,
      24,
    ],
    [
      "diff",
      { ...block({ _tag: "Diff", path: "src/main.ts", patch: "-old\n+new" }), expandedRowKeys: ["block:Diff:0"] },
      80,
      24,
    ],
    [
      "diff-complex",
      {
        ...block({
          _tag: "Diff",
          path: "src/renamed.ts",
          patch:
            "similarity index 92%\nrename from src/old.ts\nrename to src/renamed.ts\n@@ -1,3 +1,4 @@\n-old red line\n+new green line\n context\n@@ -20,2 +21,3 @@\n-another removal\n+another addition with a deliberately long value that exercises clipping and wrapping behavior across the card width\nBinary files assets/old.png and assets/new.png differ",
        }),
        expandedRowKeys: ["block:Diff:0"],
      },
      80,
      24,
    ],
    [
      "diff-highlighted",
      {
        ...block({
          _tag: "Diff",
          path: "src/agent.ts",
          patch:
            '--- a/src/agent.ts\n+++ b/src/agent.ts\n@@ -224,5 +224,5 @@\n   {\n     name: "oracle",\n-    description: "Delegate a focused technical investigation",\n+    description: "Delegate planning, review, and debugging",\n     permission: "allow",\n',
        }),
        expandedRowKeys: ["block:Diff:0"],
      },
      80,
      24,
    ],
    [
      "edit-streaming",
      block({
        _tag: "ToolCall",
        id: "streaming-edit",
        name: "edit",
        input: JSON.stringify({ path: "src/main.ts", old_str: "old", new_str: "new" }),
        status: "running",
        presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
        detail: "src/main.ts",
        files: [
          {
            key: "streaming-edit:0",
            path: "src/main.ts",
            kind: "update",
            patch: "--- a/src/main.ts\n+++ b/src/main.ts\n@@\n-old\n+new",
            additions: 1,
            deletions: 1,
            preview: true,
            status: "running",
          },
        ],
      }),
      80,
      24,
    ],
    [
      "tool-group-states",
      {
        ...base(),
        blocks: [
          tool("requested", "grep", "TODO", "running"),
          tool("running", "read", "README.md", "running"),
          tool("complete", "edit", "report.md", "complete", "done"),
          { _tag: "ToolResult", id: "failed", output: "permission denied", failed: true },
        ],
      },
      80,
      24,
    ],
    [
      "permission",
      block({
        _tag: "Permission",
        id: "permission-1",
        kind: "tool-approval",
        title: "Write",
        detail: "src/main.ts",
        status: "pending",
      }),
      80,
      24,
    ],
    ["mode-picker", { ...base(), modePicker: { open: true, selected: 2 } }, 80, 24],
    ["palette", { ...base(), paletteOpen: true, palette: { open: true, query: "", selected: 0 } }, 80, 24],
    ["shortcuts", { ...base(), shortcutsOpen: true }, 80, 24],
    [
      "file-picker",
      { ...base(), filePicker: { open: true, query: "src", selected: 0, items: ready(["src/main.ts"]) } },
      80,
      24,
    ],
    ["thread-switcher", threadBrowser(), 200, 66],
    ["thread-switcher-stacked", threadBrowser(), 119, 30],
    [
      "sidebar",
      {
        ...base(),
        currentThreadId: "thread-1",
        threadSidebar: { open: true, focused: false, selected: 0, scrollTop: 0 },
        threads: [thread({ id: "thread-1", title: "Visual baseline", unread: true })],
      },
      80,
      24,
    ],
    ["changed-files-loading", { ...base(), changedFilesOpen: true, changedFiles: { _tag: "Loading" } }, 80, 24],
    [
      "changed-files-ready",
      {
        ...base(),
        changedFilesOpen: true,
        changedFiles: ready([
          { path: "src/main.ts", status: "M", added: 3, removed: 1 },
          { path: "src/theme.ts", status: "A", added: 8, removed: 0 },
        ]),
      },
      80,
      24,
    ],
    [
      "queued-turn",
      {
        ...replaceQueue({ ...base(), busy: true, activity: { _tag: "RunningTools" } }, [
          { id: "queued-turn", prompt: "Run verification next" },
        ]),
        queueSelection: "queued-turn",
      },
      80,
      24,
    ],
    [
      "child-workflow",
      {
        ...base(),
        blocks: [
          { _tag: "ChildAgent", name: "review", summary: "Checking tests", status: "running" },
          { _tag: "Workflow", name: "release", step: "verify", status: "waiting" },
        ],
      },
      80,
      24,
    ],
    [
      "cancelled-subagent",
      {
        ...base(),
        blocks: [
          {
            _tag: "ToolCall",
            id: "parent",
            name: "task",
            input: "{}",
            status: "cancelled",
            presentation: {
              family: "agent",
              action: "task",
              activeLabel: "Subagent working",
              completeLabel: "Subagent finished",
            },
            detail: "Wait then run the checks",
            childId: "child",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-shell",
            name: "bash",
            input: JSON.stringify({ command: "sleep 60" }),
            status: "cancelled",
            presentation: {
              family: "shell",
              action: "command",
              activeLabel: "Running",
              completeLabel: "Ran",
            },
            detail: "sleep 60",
            files: [],
          },
        ],
        items: [
          { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
          { _tag: "Block", index: 1, id: "tool:child-shell", turnId: "child", parentId: "parent" },
        ],
        expandedRowKeys: ["tool:parent"],
      },
      80,
      24,
    ],
    [
      "image",
      block({
        _tag: "ImageAttachment",
        name: "screen.png",
        mediaType: "image/png",
        width: 800,
        height: 600,
        bytes: 1200,
      }),
      80,
      24,
    ],
    ["narrow-layout", { ...base(), width: 50, height: 12, input: "narrow", cursor: 6 }, 50, 12],
    ["narrow-mode-overlay", { ...base(), modePicker: { open: true, selected: 1 } }, 32, 12],
    [
      "narrow-palette-overlay",
      { ...base(), paletteOpen: true, palette: { open: true, query: "thread", selected: 0 } },
      32,
      12,
    ],
    [
      "narrow-permission",
      block({
        _tag: "Permission",
        id: "narrow",
        kind: "permission",
        title: "Shell",
        detail: "bun run verification with a long command",
        status: "pending",
      }),
      32,
      12,
    ],
    ["restart-replay", restarted, 80, 24],
  ]
}

type Captured = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>

const channel = (value: number): number => Math.round(value <= 1 ? value * 255 : value)
const stableFrame = (frame: string): string => frame.replaceAll(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠿")
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const prettyJson = (value: unknown, depth = 0): string => {
  if (value === null || typeof value !== "object") return encodeJson(value)
  const indent = "  ".repeat(depth)
  const nestedIndent = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return `[\n${value.map((item) => `${nestedIndent}${prettyJson(item, depth + 1)}`).join(",\n")}\n${indent}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return "{}"
  return `{\n${entries
    .map(([key, item]) => `${nestedIndent}${encodeJson(key)}: ${prettyJson(item, depth + 1)}`)
    .join(",\n")}\n${indent}}`
}

const screenshot = (capture: Captured, width: number, height: number): string => {
  const pixels: Array<string> = []
  for (let y = 0; y < height; y += 1) {
    const cells = (capture.lines[y]?.spans ?? []).flatMap((span) =>
      Array.from(span.text).map((character) => ({ character, span })),
    )
    for (let x = 0; x < width; x += 1) {
      const cell = cells[x]
      const color = cell?.character === " " ? cell.span.bg : cell?.span.fg
      pixels.push(color !== undefined ? `${channel(color.r)} ${channel(color.g)} ${channel(color.b)}` : "0 0 0")
    }
  }
  return `P3\n${width} ${height}\n255\n${pixels.join("\n")}\n`
}

export const captureVisuals = Effect.fn("Visual.captureVisuals")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fileSystem.makeDirectory(directory, { recursive: true })
  yield* fileSystem.writeFileString(path.join(directory, "metadata.json"), `${prettyJson(visualMetadata)}\n`)
  yield* Effect.forEach(scenarios(), ([name, source, width, height]) =>
    Effect.gen(function* () {
      const setup = yield* Effect.acquireRelease(
        Effect.tryPromise(() => createTestRenderer({ width, height })),
        (value) => Effect.sync(() => value.renderer.destroy()),
      )
      const surface = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false }),
        ),
        (value) => Effect.sync(() => value.destroy()),
      )
      setup.resize(width, height)
      surface.update({ ...source, width, height })
      yield* Effect.tryPromise(() => setup.flush())
      yield* Effect.tryPromise(() => setup.renderOnce())
      const frame = stableFrame(setup.captureCharFrame())
      const styles = setup.captureSpans()
      yield* Effect.all(
        [
          fileSystem.writeFileString(
            path.join(directory, `${name}.frame.txt`),
            `${frame.replaceAll(/ +$/gm, "").trimEnd()}\n`,
          ),
          fileSystem.writeFileString(path.join(directory, `${name}.ppm`), screenshot(styles, width, height)),
          fileSystem.writeFileString(path.join(directory, `${name}.styles.json`), `${prettyJson(styles)}\n`),
        ],
        { concurrency: 3 },
      )
    }).pipe(Effect.scoped),
  )
})
