import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, layer } from "@effect/vitest"
import * as LocalTools from "@rika/execution/local-tools"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { Context, Effect, FileSystem, Layer } from "effect"
import { ToolExecutor } from "generalist"

layer(BunServices.layer)("local tool composition", (it) => {
  it.effect("provides the model executor and recorded-shell runtime from one layer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-tools-" })
      const context = yield* Layer.build(LocalTools.layer(workspace).pipe(Layer.provide(BunServices.layer)))
      expect(Context.get(context, ToolExecutor.ToolExecutor)).toBeDefined()
      expect(Context.get(context, ToolRuntime.Service)).toBeDefined()
    }),
  )
})
