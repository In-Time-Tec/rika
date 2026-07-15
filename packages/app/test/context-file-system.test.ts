import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ContextFileSystem } from "../src"
import { provideLayer } from "./layer"

describe("ContextFileSystem", () => {
  it.effect("delegates filesystem operations and converts directory errors to absence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-" })
        yield* fileSystem.writeFileString(`${root}/file.txt`, "content")
        const context = yield* ContextFileSystem.Service
        expect(yield* context.exists(`${root}/file.txt`)).toBe(true)
        expect(yield* context.exists(`${root}/missing`)).toBe(false)
        expect(yield* context.readDirectory(root)).toContain("file.txt")
        expect(yield* context.readDirectory(`${root}/missing`)).toBeUndefined()
        expect(yield* context.readFileString(`${root}/file.txt`)).toBe("content")
        expect((yield* Effect.result(context.readFileString(`${root}/missing`)))._tag).toBe("Failure")
      }),
    ).pipe(
      provideLayer(Layer.merge(ContextFileSystem.liveLayer.pipe(Layer.provide(BunServices.layer)), BunServices.layer)),
    ),
  )

  it.effect("provides normalized deterministic test files and directories", () =>
    Effect.gen(function* () {
      const context = yield* ContextFileSystem.Service
      expect(yield* context.exists("./file.txt")).toBe(true)
      expect(yield* context.exists("./directory")).toBe(true)
      expect(yield* context.exists("./missing")).toBe(false)
      expect(yield* context.readDirectory("./directory")).toEqual(["entry"])
      expect(yield* context.readDirectory("./missing")).toBeUndefined()
      expect(yield* context.readFileString("./file.txt")).toBe("content")
      expect((yield* Effect.exit(context.readFileString("./missing")))._tag).toBe("Failure")
    }).pipe(
      provideLayer(
        ContextFileSystem.testLayer({ "./file.txt": "content" }, { "./directory": ["entry"] }).pipe(
          Layer.provide(Layer.merge(BunServices.layer, Path.layer)),
        ),
      ),
    ),
  )
})
