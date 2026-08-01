import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"

describe("Transcript projection", () => {
  const streamingToolBlock = (name: string, partialInput: string) => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "0",
        sequence: 0,
        type: "model.toolcall.delta",
        createdAt: 0,
        data: { tool_call_id: "call", tool_name: name, delta: partialInput },
      },
    ])
    const unit = projection.units.find((candidate) => candidate.key === "tool:turn-a:call")!
    if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")
      throw new Error("expected a streaming ToolCall block")
    return unit.content.block
  }

  it("derives a shell command detail from streaming input before the JSON closes", () => {
    expect(streamingToolBlock("bash", "").detail).toBe("")
    expect(streamingToolBlock("bash", '{"command":').detail).toBe("")
    expect(streamingToolBlock("bash", '{"command":"mkdir -p src/tools').detail).toBe("mkdir -p src/tools")
    expect(streamingToolBlock("bash", '{"command":"echo one\\necho two').detail).toBe("echo one\necho two")
    const settled = streamingToolBlock("bash", '{"command":"echo done"}')
    expect(settled.detail).toBe("echo done")
    expect(settled.detail.includes('{"')).toBe(false)
  })

  it("never carries the raw input JSON blob into a streaming shell detail", () => {
    const raw = '{"command":"cat > a.ts <<EOF\\nimport x\\nEOF","timeout":30000}'
    for (let cut = 1; cut <= raw.length; cut += 1) {
      expect(streamingToolBlock("bash", raw.slice(0, cut)).detail.includes('{"')).toBe(false)
    }
  })

  it("derives an edit path and file preview from streaming input", () => {
    expect(streamingToolBlock("edit", '{"old_str":"a').files).toEqual([])
    const withPath = streamingToolBlock("edit", '{"path":"src/tools/edit.ts","old_str":"const x')
    expect(withPath.detail).toBe("src/tools/edit.ts")
    expect(withPath.files[0]?.path).toBe("src/tools/edit.ts")
    expect(withPath.files[0]?.kind).toBe("update")
  })

  it("derives a write path and create preview from streaming input", () => {
    const block = streamingToolBlock("write", '{"path":"src/app.ts","content":"export const a')
    expect(block.detail).toBe("src/app.ts")
    expect(block.files[0]?.path).toBe("src/app.ts")
    expect(block.files[0]?.kind).toBe("add")
  })
})
