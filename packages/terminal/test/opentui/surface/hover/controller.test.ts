import stringWidth from "string-width"
import { describe, expect, test } from "vitest"
import { buildTranscript } from "../../../../src/opentui/rendering/renderer"
import { transcriptWrapWidth } from "../../../../src/opentui/rendering/transcript/window"
import {
  expandableRowIds,
  transcriptUnits,
  transcriptUnitId as unitId,
} from "../../../../src/presentation/transcript/row"
import { initial, type Model } from "../../../../src/state/model"
import { type TranscriptBlock } from "../../../../src/state/transcript/model"

const longText =
  "Expected UnknownResponseStreamEvent, got " +
  JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
    },
    sequence_number: 2,
  })

const longDiff = [
  "--- a/packages/providers/README.md",
  "+++ b/packages/providers/README.md",
  "@@ -68,3 +68,5 @@",
  " Credentials are resolved for each request. An optional secret-free recovery hook is coalesced by rejected credential generation and can run the login command.",
  "+SigV4 signs the final buffered Responses body with service bedrock-mantle; the regional endpoint and signing region must match across named profiles and SSO.",
  "+Bearer authentication accepts a dynamic BearerTokens source or bearerTokens(Redacted.make(token)) without TenetKit minting or persisting any secret material.",
  "",
].join("\n")

const toolCall = (id: string, changes: Partial<Extract<TranscriptBlock, { _tag: "ToolCall" }>>) =>
  ({
    _tag: "ToolCall",
    id,
    name: "tool",
    input: "{}",
    status: "complete",
    presentation: { family: "direct", action: "other", activeLabel: "Running", completeLabel: "Ran" },
    detail: "",
    files: [],
    ...changes,
  }) as TranscriptBlock

const nestedCommand = `git show --format=fuller ${"a".repeat(180)} -- packages/terminal/src/opentui/surface/opentui-surface.ts packages/terminal/test/transcript-bounds.test.ts`

const blocks: ReadonlyArray<TranscriptBlock> = [
  { _tag: "Reasoning", text: `${longText} ${longText}` },
  {
    _tag: "Error",
    title: "Execution failed",
    detail: `${longText}\n${longText}`,
    turnId: "turn-1",
    category: "operation",
    retryable: false,
  },
  { _tag: "Notification", title: "Notice", detail: longText },
  { _tag: "Compaction", summary: longText, checkpoint: "42" },
  { _tag: "Diff", path: "packages/providers/README.md", patch: longDiff },
  toolCall("shell-1", {
    presentation: { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
    input: JSON.stringify({
      command: `echo ${"a".repeat(90)} && rg --hidden --glob '!node_modules' ${"b".repeat(60)}`,
    }),
    output: `${longText}\n${longText}`,
  }),
  toolCall("shell-2", {
    presentation: { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
    input: JSON.stringify({ command: nestedCommand }),
    detail: nestedCommand,
  }),
  toolCall("edit-1", {
    presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
    files: [
      {
        key: "readme",
        path: "packages/providers/README.md",
        kind: "update",
        additions: 2,
        deletions: 0,
        status: "complete",
        preview: false,
        patch: longDiff,
      },
    ],
  }),
  toolCall("agent-1", {
    presentation: { family: "agent", action: "agent", activeLabel: "Oracle exploring", completeLabel: "Oracle" },
    detail: `${longText} ${longText}`,
  }),
  toolCall("web-1", {
    presentation: {
      family: "direct",
      action: "web-search",
      activeLabel: "Web Search",
      completeLabel: "Web Search",
      outputDisplay: "hidden",
    },
    status: "failed",
    output: longText,
  }),
  toolCall("nested-agent", {
    status: "running",
    presentation: {
      family: "agent",
      action: "agent",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "Inspect the transcript renderer",
  }),
  toolCall("nested-shell", {
    presentation: { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
    input: JSON.stringify({ command: nestedCommand }),
    detail: nestedCommand,
  }),
  {
    _tag: "SubagentCard",
    id: "child",
    name: "oracle",
    prompt: "",
    promptTruncated: false,
    summary: longText,
    status: "complete",
    activity: [longText],
  },
]

const boundedModel = (width: number): Model => {
  const base: Model = {
    ...initial("/workspace", "medium"),
    width,
    blocks,
    items: blocks.map((block, index) =>
      block._tag === "ToolCall" && block.id === "nested-shell"
        ? { _tag: "Block" as const, index, id: `item:${index}`, turnId: "turn", parentId: "nested-agent" }
        : { _tag: "Block" as const, index, id: `item:${index}`, turnId: "turn" },
    ),
    entries: [
      { role: "assistant", text: `${longText} ${longText} ${"u".repeat(200)}`, turnId: "turn" },
      { role: "user", text: `${longText} ${longText}`, turnId: "turn" },
    ],
  }
  const withEntries: Model = {
    ...base,
    items: [
      ...base.items,
      { _tag: "Entry" as const, index: 0, id: "entry:0", turnId: "turn" },
      { _tag: "Entry" as const, index: 1, id: "entry:1", turnId: "turn" },
    ],
  }
  const expanded = [
    ...expandableRowIds(withEntries),
    ...transcriptUnits(withEntries).map((unit) => unitId(withEntries, unit)),
  ]
  return { ...withEntries, expandedRowKeys: [...new Set(expanded)] }
}

describe("transcript bounds", () => {
  for (const width of [60, 80, 132]) {
    test(`no rendered line escapes the wrap budget at width ${width}`, () => {
      const value = boundedModel(width)
      const budget = transcriptWrapWidth(width)
      const rendered = buildTranscript(value)
        .styled.chunks.map((chunk) => chunk.text)
        .join("")
      for (const line of rendered.split("\n")) {
        expect(stringWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(budget)
      }
    })
  }
})
