import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ToolExecutor } from "@rika/agent"
import { Config } from "@rika/core"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect } from "effect"
import { HashlineFile } from "../src/index"

const tempWorkspace = () => mkdtemp(join(tmpdir(), "rika-hashline-"))

const configLayer = (workspaceRoot: string) =>
  Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: join(workspaceRoot, ".rika"),
    default_mode: "smart",
  })

const run = <A, E>(workspaceRoot: string, effect: Effect.Effect<A, E, HashlineFile.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(HashlineFile.layer), Effect.provide(configLayer(workspaceRoot))))

const runTool = <A, E>(workspaceRoot: string, effect: Effect.Effect<A, E, ToolExecutor.Service>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(HashlineFile.toolExecutorLayer), Effect.provide(configLayer(workspaceRoot))),
  )

const call = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name}`),
  name,
  input,
})

describe("HashlineFile", () => {
  test("read returns LINE:HASH anchors that disambiguate duplicate lines", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "same.txt"), "same\nsame\nlast\n")

    const output = object(await run(root, HashlineFile.read({ path: "same.txt" })))
    const anchors = array(output.anchors).map(object)

    expect(output.content).toMatch(/^1:[A-Za-z0-9_-]{4}\|same\n2:[A-Za-z0-9_-]{4}\|same/m)
    expect(string(anchors[0]?.hash)).not.toBe(string(anchors[1]?.hash))
    expect(string(anchors[0]?.anchor)).toMatch(/^1:[A-Za-z0-9_-]{4}$/)
    expect(output.render).toMatchObject({ kind: "file", renderer: "@pierre/diffs", collapsed: true })
  })

  test("edit rejects stale anchors and returns nearby fresh anchors", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "stale.ts"), "one\ntwo\nthree\n")
    const read = object(await run(root, HashlineFile.read({ path: "stale.ts" })))
    const staleAnchor = string(object(array(read.anchors)[1]).anchor)

    await writeFile(join(root, "stale.ts"), "one\nchanged\nthree\n")
    const error = await Effect.runPromise(
      HashlineFile.edit({
        path: "stale.ts",
        edits: [{ type: "set_line", anchor: staleAnchor, new_text: "TWO" }],
      }).pipe(Effect.flip, Effect.provide(HashlineFile.layer), Effect.provide(configLayer(root))),
    )

    expect(error.code).toBe("E_STALE_ANCHOR")
    expect(error.retryable).toBe(true)
    expect(error.details).toMatchObject({ provided_anchor: staleAnchor })
    expect(array(object(error.details).fresh_anchors).length).toBeGreaterThan(0)
  })

  test("edit validates one pre-edit snapshot and applies line operations bottom-up", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "order.ts"), "a\nb\nc\n")
    const read = object(await run(root, HashlineFile.read({ path: "order.ts" })))
    const anchors = array(read.anchors).map(object)

    await run(
      root,
      HashlineFile.edit({
        path: "order.ts",
        edits: [
          { type: "delete_range", anchor: string(anchors[0]?.anchor) },
          { type: "set_line", anchor: string(anchors[2]?.anchor), new_text: "C" },
        ],
      }),
    )

    expect(await readFile(join(root, "order.ts"), "utf8")).toBe("b\nC\n")
  })

  test("edit rejects copied hashline and bare hash prefixes", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "patch.ts"), "value\n")
    const read = object(await run(root, HashlineFile.read({ path: "patch.ts" })))
    const anchor = string(object(array(read.anchors)[0]).anchor)

    const invalidPatch = await Effect.runPromise(
      HashlineFile.edit({
        path: "patch.ts",
        edits: [{ type: "set_line", anchor, new_text: `${anchor}|copied` }],
      }).pipe(Effect.flip, Effect.provide(HashlineFile.layer), Effect.provide(configLayer(root))),
    )
    const bareHash = await Effect.runPromise(
      HashlineFile.edit({
        path: "patch.ts",
        edits: [{ type: "set_line", anchor, new_text: `${anchor.slice(anchor.indexOf(":") + 1)}|copied` }],
      }).pipe(Effect.flip, Effect.provide(HashlineFile.layer), Effect.provide(configLayer(root))),
    )

    expect(invalidPatch.code).toBe("E_INVALID_PATCH")
    expect(bareHash.code).toBe("E_BARE_HASH_PREFIX")
  })

  test("edit preserves CRLF and BOM when rewriting", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "windows.ts"), "\uFEFFfirst\r\nsecond\r\n")
    const read = object(await run(root, HashlineFile.read({ path: "windows.ts" })))
    const anchor = string(object(array(read.anchors)[1]).anchor)

    await run(
      root,
      HashlineFile.edit({
        path: "windows.ts",
        edits: [{ type: "set_line", anchor, new_text: "SECOND" }],
      }),
    )

    const bytes = await readFile(join(root, "windows.ts"))
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(text).toBe("\uFEFFfirst\r\nSECOND\r\n")
  })

  test("write is atomic at the workspace path and returns Pierre diff metadata", async () => {
    const root = await tempWorkspace()
    const output = object(
      await run(root, HashlineFile.write({ path: "nested/new.ts", content: "export const value = 1\n" })),
    )

    expect(await readFile(join(root, "nested/new.ts"), "utf8")).toBe("export const value = 1\n")
    expect(await readdir(join(root, "nested"))).toEqual(["new.ts"])
    expect(output.diff).toMatchObject({ kind: "diff", renderer: "@pierre/diffs", collapsed: true })
    expect(object(output.diff).file_diff).toMatchObject({ name: "nested/new.ts", isPartial: false })
    expect(array(output.anchors).length).toBe(1)
  })

  test("replace_text is the explicit exact-replace escape hatch", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "exact.ts"), "alpha\nbeta\n")

    await run(
      root,
      HashlineFile.edit({
        path: "exact.ts",
        edits: [{ type: "replace_text", old_text: "alpha", new_text: "ALPHA", exact: true }],
      }),
    )

    expect(await readFile(join(root, "exact.ts"), "utf8")).toBe("ALPHA\nbeta\n")
  })

  test("tool registry layer exposes shell plus hashline read/write/edit tools", async () => {
    const root = await tempWorkspace()
    const writeResult = await runTool(
      root,
      ToolExecutor.execute(call("write", { path: "tool.txt", content: "hello\n" })),
    )
    const readResult = await runTool(root, ToolExecutor.execute(call("read", { path: "tool.txt" })))

    expect(writeResult).toMatchObject({ status: "success", name: "write" })
    expect(readResult).toMatchObject({ status: "success", name: "read" })
    expect(object(readResult.output).content).toMatch(/^1:[A-Za-z0-9_-]{4}\|hello$/)

    const shell = await runTool(root, ToolExecutor.execute(call("shell.command", { command: "printf ok" })))
    expect(shell).toMatchObject({ status: "success", output: { stdout: "ok" } })
  })
})

const object = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) return value
  throw new Error(`Expected object, got ${typeof value}`)
}

const array = (value: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value
  throw new Error(`Expected array, got ${typeof value}`)
}

const string = (value: unknown): string => {
  if (typeof value === "string") return value
  throw new Error(`Expected string, got ${typeof value}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
