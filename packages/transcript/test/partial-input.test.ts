import { describe, expect, it } from "@effect/vitest"
import { partialInputRecord } from "../src/projection/partial-tool-input"

describe("partialInputRecord", () => {
  it("extracts every field from complete object input", () => {
    const input = JSON.stringify({ path: "src/app.ts", old_str: "a\nb", new_str: "c\td", replace_all: true })
    expect(partialInputRecord(input)).toEqual({
      path: "src/app.ts",
      old_str: "a\nb",
      new_str: "c\td",
      replace_all: true,
    })
  })

  it("returns an empty record before any field starts", () => {
    for (const prefix of ["", "{", "{ ", '{"', '{"pa', '{"path"', '{"path":', '{"path": ']) {
      expect(partialInputRecord(prefix)).toEqual({})
    }
  })

  it("returns a partial string value as a usable prefix while it streams", () => {
    expect(partialInputRecord('{"path":"src/too')).toEqual({ path: "src/too" })
    expect(partialInputRecord('{"path":"src/tools/edit.ts"')).toEqual({ path: "src/tools/edit.ts" })
    expect(partialInputRecord('{"path":"src/tools/edit.ts",')).toEqual({ path: "src/tools/edit.ts" })
    expect(partialInputRecord('{"path":"src/tools/edit.ts","old_str":"const x')).toEqual({
      path: "src/tools/edit.ts",
      old_str: "const x",
    })
  })

  it("unescapes newlines and quotes inside a streaming string value", () => {
    expect(partialInputRecord('{"command":"mkdir -p src/tools\\ncat > a.ts')).toEqual({
      command: "mkdir -p src/tools\ncat > a.ts",
    })
    expect(partialInputRecord('{"command":"echo \\"hi\\"')).toEqual({ command: 'echo "hi"' })
    expect(partialInputRecord('{"command":"a\\tb')).toEqual({ command: "a\tb" })
  })

  it("drops a dangling escape at the truncation boundary", () => {
    expect(partialInputRecord('{"command":"line one\\')).toEqual({ command: "line one" })
    expect(partialInputRecord('{"command":"snowman \\u26')).toEqual({ command: "snowman " })
    expect(partialInputRecord('{"command":"snowman \\u2603')).toEqual({ command: "snowman ☃" })
  })

  it("keeps a completed first field when the next key is mid-stream", () => {
    expect(partialInputRecord('{"objective":"find docs","que')).toEqual({ objective: "find docs" })
    expect(partialInputRecord('{"url":"https://example.com","full')).toEqual({ url: "https://example.com" })
  })

  it("never yields raw JSON as a field value", () => {
    for (let cut = 1; cut <= 60; cut += 1) {
      const record = partialInputRecord('{"command":"cat > a.ts <<EOF\\nimport x\\nEOF","timeout":30000}'.slice(0, cut))
      for (const value of Object.values(record)) {
        if (typeof value === "string") expect(value.includes('{"')).toBe(false)
      }
    }
  })

  it("captures completed nested arrays and scalars", () => {
    expect(partialInputRecord('{"path":"a.ts","read_range":[10,20]}')).toEqual({ path: "a.ts", read_range: [10, 20] })
    expect(partialInputRecord('{"path":"a.ts","offset":40,"limit":80}')).toEqual({
      path: "a.ts",
      offset: 40,
      limit: 80,
    })
  })

  it("stops at a truncated nested value but keeps earlier fields", () => {
    expect(partialInputRecord('{"path":"a.ts","read_range":[10,')).toEqual({ path: "a.ts" })
  })
})
