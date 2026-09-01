import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Runtime from "@rika/product/native-tool-runtime"
import { Catalog } from "@rika/product/native-tool-catalog"
import * as Bash from "@rika/product/bash-tool"
import * as Edit from "@rika/product/edit-file-tool"
import * as Read from "@rika/product/read-file-tool"
import * as ShellCommandStatus from "@rika/product/shell-command-status-tool"
import { provideLayer } from "../../support/product-layer"

describe("native tool product contracts", () => {
  it("publishes exactly the four native tools in stable order", () => {
    expect(Catalog.definitions.map(({ name }) => name)).toEqual(["bash", "shell_command_status", "read", "edit"])
    expect(Object.keys(Runtime.toolkit.tools)).toEqual(["bash", "shell_command_status", "read", "edit"])
    expect(Catalog.definitions.filter(({ idempotency }) => idempotency === "unsafe").map(({ name }) => name)).toEqual([
      "bash",
      "edit",
    ])
    expect(Catalog.get("write")).toBeUndefined()
    expect(Catalog.get("web_search")).toBeUndefined()
    expect(Catalog.get("find_thread")).toBeUndefined()
  })

  it("keeps the native model-facing schemas and presentation policies", () => {
    expect(Tool.getJsonSchema(Bash.tool)).toMatchObject({
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["command"],
    })
    expect(Tool.getJsonSchema(Read.tool)).toMatchObject({
      properties: {
        path: { type: "string" },
        read_range: { type: "array", allOf: [{ minItems: 2 }, { maxItems: 2 }] },
      },
      required: ["path"],
    })
    expect(Tool.getJsonSchema(Edit.tool)).toMatchObject({
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_str", "new_str"],
    })
    expect(Tool.getJsonSchema(ShellCommandStatus.tool)).toMatchObject({
      properties: { processId: { type: "string" } },
      required: ["processId"],
    })
    expect(Catalog.get("read")?.presentation).toMatchObject({ family: "explore", action: "read" })
    expect(Catalog.get("edit")?.presentation).toMatchObject({ family: "edit", action: "edit" })
    expect(Catalog.get("bash")?.presentation).toMatchObject({ family: "shell", action: "command" })
    expect(Catalog.get("shell_command_status")?.presentation).toMatchObject({
      family: "direct",
      action: "status",
      rowDisplay: "continuation",
      failedLabel: "Command wait failed",
    })
  })

  it.effect("keeps the runtime port typed for native and recorded shell requests", () =>
    Effect.gen(function* () {
      const native = yield* Schema.decodeEffect(Runtime.Request)({ _tag: "Read", path: "a.ts", readRange: [1, 2] })
      const recorded = yield* Schema.decodeEffect(Runtime.Request)({
        _tag: "Shell",
        command: "sh",
        args: ["-c", "printf ok"],
        waitMillis: 10_000,
      })
      expect(native).toEqual({ _tag: "Read", path: "a.ts", readRange: [1, 2] })
      expect(recorded._tag).toBe("Shell")
    }),
  )

  it.effect("provides a test adapter for the runtime port", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      expect(yield* runtime.run({ _tag: "Bash", command: "printf ok" })).toEqual({ text: "ok", truncated: false })
    }).pipe(provideLayer(Runtime.testLayer(() => Effect.succeed({ text: "ok", truncated: false })))),
  )
})
