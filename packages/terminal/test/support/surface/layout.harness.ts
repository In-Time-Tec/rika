import { initial, type Model } from "../../../src/state/model"
import { ready } from "../../../src/state/loadable"
import { replaceQueue } from "../../../src/state/queue/model"
import type { TranscriptBlock } from "../../../src/state/transcript/model"
import { thread, threadBrowser } from "./thread-browser.fixture"

const block = (value: TranscriptBlock): Model => ({
  ...initial("/workspace", "high"),
  blocks: [value],
})
const tool = (
  id: string,
  name: string,
  detail: string,
  status: Extract<TranscriptBlock, { _tag: "ToolCall" }>["status"],
  output?: string,
): Extract<TranscriptBlock, { _tag: "ToolCall" }> => {
  const value: Extract<TranscriptBlock, { _tag: "ToolCall" }> = {
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
  }
  if (output === undefined) return value
  return { ...value, result: { text: output } }
}
const base = (): Model => initial("/workspace", "high")

export const scenarios = (): ReadonlyArray<readonly [string, Model, number, number]> => {
  const reasoning = block({ _tag: "Reasoning", text: "Inspecting stable inputs" })
  return [
    ["welcome", base(), 80, 24],
    ["prompt", { ...base(), input: "Explain this repository", cursor: 23 }, 80, 24],
    [
      "streaming",
      {
        ...base(),
        busy: true,
        entries: [{ role: "assistant", text: "Streaming deterministic text…" }],
      },
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
            text: "# Styled Markdown\n\n**bold** and *emphasis* with `inline code`.\n\n| Layer | Owner |\n|---|---|\n| Durable execution | Generalist |\n| Product state | Rika |\n\n> muted quote\n\n```ts\nconst answer = 42\n```",
          },
        ],
      },
      80,
      24,
    ],
    ["reasoning", reasoning, 80, 24],
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
      {
        ...block({ _tag: "Diff", path: "src/main.ts", patch: "-old\n+new" }),
        expandedRowKeys: ["block:Diff:0"],
      },
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
        presentation: {
          family: "edit",
          action: "edit",
          activeLabel: "Editing",
          completeLabel: "Edited",
        },
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
    ["mode-picker", { ...base(), modePicker: { open: true, selected: 2 } }, 80, 24],
    [
      "context-meter",
      {
        ...base(),
        currentThreadId: "context-thread",
        contextUsage: {
          _tag: "Available",
          inputTokens: 208_294,
          inputCacheRead: 52_073,
          inputTotal: 52_073,
          contextWindow: 1_050_000,
          reserveTokens: 128_000,
        },
      },
      80,
      24,
    ],
    [
      "meter-scanner",
      {
        ...base(),
        currentThreadId: "context-thread",
        busy: true,
        contextUsage: { _tag: "Loading" },
      },
      80,
      24,
    ],
    [
      "meter-muncher-open",
      {
        ...base(),
        currentThreadId: "context-thread",
        busy: true,
        activity: { _tag: "Streaming", bytes: 20 },
        contextUsage: {
          _tag: "Available",
          inputCacheRead: 0,
          inputTokens: 208_294,
          inputTotal: 208_294,
          contextWindow: 1_050_000,
          reserveTokens: 128_000,
        },
      },
      80,
      24,
    ],
    [
      "meter-muncher-closed",
      {
        ...base(),
        currentThreadId: "context-thread",
        busy: true,
        animationTick: 1,
        contextAnimation: { ...base().contextAnimation, munchTick: 1 },
        activity: { _tag: "Streaming", bytes: 20 },
        contextUsage: {
          _tag: "Available",
          inputCacheRead: 0,
          inputTokens: 208_294,
          inputTotal: 208_294,
          contextWindow: 1_050_000,
          reserveTokens: 128_000,
        },
      },
      80,
      24,
    ],
    [
      "meter-vacuum",
      {
        ...base(),
        currentThreadId: "context-thread",
        contextAnimation: {
          munchTick: 0,
          compactFromPercent: 90,
          compactTick: 0,
          flashTicks: 0,
          flashed75: false,
          flashed90: false,
        },
        contextUsage: {
          _tag: "Available",
          inputCacheRead: 0,
          inputTokens: 208_294,
          inputTotal: 208_294,
          contextWindow: 1_050_000,
          reserveTokens: 128_000,
        },
      },
      80,
      24,
    ],
    [
      "meter-flash",
      {
        ...base(),
        currentThreadId: "context-thread",
        contextAnimation: { munchTick: 0, flashTicks: 2, flashed75: true, flashed90: false },
        contextUsage: {
          _tag: "Available",
          inputCacheRead: 0,
          inputTokens: 700_000,
          inputTotal: 700_000,
          contextWindow: 1_050_000,
          reserveTokens: 128_000,
        },
      },
      80,
      24,
    ],
    [
      "context-details",
      {
        ...base(),
        currentThreadId: "context-thread",
        contextDetailsOpen: true,
        contextUsage: {
          _tag: "Available",
          inputTokens: 208_294,
          inputCacheRead: 52_073,
          inputTotal: 52_073,
          contextWindow: 1_050_000,
          reserveTokens: 128_000,
        },
        usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0, includedAttempts: 0 },
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
        usageTokens: { _tag: "Available", total: 6_811_999, uncountedAttempts: 0 },
      },
      80,
      24,
    ],
    [
      "compact-context-details",
      {
        ...base(),
        width: 24,
        height: 12,
        currentThreadId: "context-thread",
        contextDetailsOpen: true,
        contextUsage: {
          _tag: "Available",
          inputCacheRead: 0,
          inputTokens: 56_120,
          inputTotal: 56_120,
          contextWindow: 372_000,
          reserveTokens: 128_000,
        },
        usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0, includedAttempts: 0 },
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
      },
      24,
      12,
    ],
    ["palette", { ...base(), paletteOpen: true, palette: { open: true, query: "", selected: 0 } }, 80, 24],
    ["shortcuts", { ...base(), shortcutsOpen: true }, 80, 24],
    [
      "file-picker",
      {
        ...base(),
        filePicker: { open: true, query: "src", selected: 0, items: ready(["src/main.ts"]) },
      },
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
      "runner-placement",
      {
        ...base(),
        connection: {
          connectivity: "connected",
          target: "runner",
          activity: "executor-waiting",
          participants: 1,
        },
      },
      80,
      24,
    ],
    [
      "orb-placement",
      {
        ...base(),
        connection: {
          connectivity: "connected",
          target: "orb",
          activity: "workspace-preparing",
          ownership: "organization",
          participants: 2,
        },
      },
      80,
      24,
    ],
    [
      "narrow-orb-placement",
      {
        ...base(),
        connection: { connectivity: "reconnecting", target: "orb", participants: 1 },
      },
      32,
      12,
    ],
    [
      "narrow-runner-placement",
      {
        ...base(),
        connection: {
          connectivity: "connected",
          target: "runner",
          activity: "executor-waiting",
          participants: 1,
        },
      },
      32,
      12,
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
    ["compact-mode-selector", { ...base(), modePicker: { open: true, selected: 1 } }, 24, 12],
    ["narrow-mode-overlay", { ...base(), modePicker: { open: true, selected: 1 } }, 32, 12],
    [
      "narrow-palette-overlay",
      { ...base(), paletteOpen: true, palette: { open: true, query: "thread", selected: 0 } },
      32,
      12,
    ],
  ]
}
