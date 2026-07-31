import { TextAttributes } from "../src/presentation/markdown/styled-text"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { describe, expect, test } from "vitest"
import { buildTranscript } from "../src/opentui/surface/opentui-surface"
import { colors } from "../src/presentation/terminal/terminal-theme"
import { renderToolSummary } from "../src/presentation/tool/tool-summary"
import {
  expandableRowIds,
  toolDetail,
  rows as transcriptUnits,
} from "../src/presentation/transcript/terminal-transcript-presentation"
import { initial, type Model, type TranscriptBlock } from "../src/state/model/terminal-state"
import { type ToolCall, call, model, text, type RenderChunk, chunkFor, expectForeground, hasAttribute, shellPresentation, explore, streamingBlock } from "./tool-presentation.test-support"
  test("does not navigate to an expandable direct tool until it has output", () => {
    const direct = call(
      "direct",
      "custom_status",
      {},
      {
        family: "direct",
        action: "custom-status",
        activeLabel: "Checking",
        completeLabel: "Checked",
      },
    )

    expect(expandableRowIds(model([direct]))).toEqual([])
    expect(expandableRowIds(model([{ ...direct, output: "DISPLAYED RESULT" }]))).toEqual(["tool:direct"])
  })
  test("keeps explicit expandable output behavior", () => {
    const direct = call(
      "direct",
      "custom_status",
      {},
      {
        family: "direct",
        action: "custom-status",
        activeLabel: "Checking",
        completeLabel: "Checked",
        outputDisplay: "expandable",
      },
      { output: "DISPLAYED RESULT" },
    )
    const value = model([direct], ["tool:direct"])

    expect(text(value)).toContain("DISPLAYED RESULT")
    expect(expandableRowIds(value)).toEqual(["tool:direct"])
  })
  test("switches one stable row from its running label to its completed label", () => {
    const presentation = {
      family: "direct" as const,
      action: "message-thread",
      activeLabel: "Sending message to thread",
      completeLabel: "Sent message to thread",
    }
    const running = call("message", "send_message_to_thread", { thread: "T-1" }, presentation, {
      status: "running",
    })
    const complete = { ...running, status: "complete" as const, output: "sent" }

    expect(text(model([running]))).toContain("Sending message to thread")
    expect(text(model([complete]))).toContain("Sent message to thread")
    expect(transcriptUnits(model([running]))).toHaveLength(1)
    expect(transcriptUnits(model([complete]))).toHaveLength(1)
    expect(toolDetail(0, complete).label).toBe("Sent message to thread")
  })
  test("renders a styled shell command line while the tool input is still streaming", () => {
    const block = streamingBlock("bash", '{"command":"mkdir -p src/tools')
    const rendered = text(model([block]))

    expect(rendered).toContain("mkdir -p src/tools")
    expect(rendered).not.toContain('{"command"')
    expect(text(model([{ ...block, status: "complete" }]))).toContain("$ mkdir -p src/tools")
  })
  test("unescapes streamed shell newlines into real command lines", () => {
    const block = streamingBlock("bash", '{"command":"mkdir -p src/tools\\ncat > a.ts')
    const rendered = text(model([block]))

    expect(rendered).toContain("mkdir -p src/tools")
    expect(rendered).toContain("cat > a.ts")
    expect(rendered).not.toContain("\\n")
    expect(rendered).not.toContain('{"command"')
  })
  test("labels a streaming edit with its file path, never the tool name", () => {
    const block = streamingBlock("edit", '{"path":"src/tools/edit.ts","old_str":"const x')
    const rendered = text(model([block]))

    expect(rendered).toContain("Editing src/tools/edit.ts")
    expect(rendered).not.toContain("Editing edit")
    expect(rendered).not.toContain('{"path"')
  })
  test("labels a streaming write with its file path, never the tool name", () => {
    const block = streamingBlock("write", '{"path":"src/app.ts","content":"export const a')
    const rendered = text(model([block]))

    expect(rendered).toContain("Creating src/app.ts")
    expect(rendered).not.toContain("Creating write")
    expect(rendered).not.toContain('{"content"')
  })
  test("settles a streamed edit into its completed presentation", () => {
    const streaming = streamingBlock("edit", '{"path":"src/app.ts","old_str":"a","new_str":"b')
    const settled = streamingBlock("edit", '{"path":"src/app.ts","old_str":"a","new_str":"b"}')

    expect(text(model([streaming]))).toContain("Editing src/app.ts")
    expect(text(model([{ ...settled, status: "complete" }]))).toContain("Edited src/app.ts")
  })
  test("toolDetail never surfaces raw JSON or the tool name while streaming", () => {
    expect(toolDetail(0, streamingBlock("bash", '{"command":"mkdir -p src')).label).toBe("$ mkdir -p src")
    expect(toolDetail(0, streamingBlock("bash", '{"comm')).label).toBe("$")
    expect(toolDetail(0, streamingBlock("edit", '{"path":"src/app.ts","old_str":"a')).label).toBe("Edit src/app.ts")
    expect(toolDetail(0, streamingBlock("edit", '{"old_str":"a')).label).toBe("Edit")
  })
  test("shows only the running label before a shell command value begins streaming", () => {
    const rendered = text(model([streamingBlock("bash", '{"command":')]))

    expect(rendered).not.toContain('{"command"')
    expect(rendered).not.toContain("{")
  })
  test("shows the active edit label with no tool-name argument before a path streams", () => {
    const rendered = text(model([streamingBlock("edit", '{"old_str":"a')]))

    expect(rendered).toContain("Editing")
    expect(rendered).not.toContain("Editing edit")
    expect(rendered).not.toContain("{")

    const creating = text(model([streamingBlock("write", '{"content":"export')]))
    expect(creating).toContain("Creating")
    expect(creating).not.toContain("Creating write")
    expect(creating).not.toContain("{")
  })
