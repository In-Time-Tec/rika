import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import { WorkspaceFiles, layer } from "../src/workspace-files"

describe("Workspace file inspection", () => {
  it.effect("builds before repository preparation and resolves the Workspace after checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* Layer.build(BunServices.layer)
        const fileSystem = Context.get(platform, FileSystem.FileSystem)
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-files-preparation-" })
        const workspace = `${parent}/workspace`
        const context = yield* Layer.build(layer(workspace)).pipe(Effect.provide(platform))
        const files = Context.get(context, WorkspaceFiles)
        const request = {
          _tag: "WorkspaceFileInspect" as const,
          requestId: "request-preparation",
          path: "README.md",
          maximumBytes: 16,
        }

        expect(yield* files.inspect(request)).toMatchObject({
          _tag: "WorkspaceFileRejected",
          reason: "unavailable",
        })
        yield* fileSystem.makeDirectory(workspace)
        yield* fileSystem.writeFileString(`${workspace}/README.md`, "prepared")
        expect(yield* files.inspect(request)).toMatchObject({
          _tag: "WorkspaceFileContent",
          contentBase64: "cHJlcGFyZWQ=",
        })
      }),
    ),
  )

  it.effect("reads bounded regular files rooted in the authorized Workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* Layer.build(BunServices.layer)
        const fileSystem = Context.get(platform, FileSystem.FileSystem)
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-files-" })
        const workspace = `${parent}/workspace`
        yield* fileSystem.makeDirectory(`${workspace}/src`, { recursive: true })
        yield* fileSystem.writeFileString(`${workspace}/src/value.txt`, "hello")
        const context = yield* Layer.build(layer(workspace)).pipe(Effect.provide(platform))
        const files = Context.get(context, WorkspaceFiles)

        expect(
          yield* files.inspect({
            _tag: "WorkspaceFileInspect",
            requestId: "request-1",
            path: "src/value.txt",
            maximumBytes: 5,
          }),
        ).toEqual({
          _tag: "WorkspaceFileContent",
          requestId: "request-1",
          path: "src/value.txt",
          sizeBytes: 5,
          contentBase64: "aGVsbG8=",
        })
      }),
    ),
  )

  it.effect("rejects traversal, symlink escapes, non-files, missing files, and oversized content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* Layer.build(BunServices.layer)
        const fileSystem = Context.get(platform, FileSystem.FileSystem)
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-files-boundary-" })
        const workspace = `${parent}/workspace`
        yield* fileSystem.makeDirectory(`${workspace}/directory`, { recursive: true })
        yield* fileSystem.writeFileString(`${workspace}/large.txt`, "12345")
        yield* fileSystem.writeFileString(`${parent}/secret.txt`, "secret")
        yield* fileSystem.symlink(`${parent}/secret.txt`, `${workspace}/secret.txt`)
        const context = yield* Layer.build(layer(workspace)).pipe(Effect.provide(platform))
        const files = Context.get(context, WorkspaceFiles)
        const inspect = (path: string, maximumBytes = 16) =>
          files.inspect({ _tag: "WorkspaceFileInspect", requestId: path, path, maximumBytes })

        expect(yield* inspect("../missing.txt")).toMatchObject({ _tag: "WorkspaceFileRejected", reason: "invalid" })
        expect(yield* inspect(`${workspace}/large.txt`)).toMatchObject({
          _tag: "WorkspaceFileRejected",
          reason: "invalid",
        })
        expect(yield* inspect("secret.txt")).toMatchObject({ _tag: "WorkspaceFileRejected", reason: "invalid" })
        expect(yield* inspect("directory")).toMatchObject({ _tag: "WorkspaceFileRejected", reason: "not-file" })
        expect(yield* inspect("missing.txt")).toMatchObject({ _tag: "WorkspaceFileRejected", reason: "not-found" })
        expect(yield* inspect("large.txt", 4)).toMatchObject({ _tag: "WorkspaceFileRejected", reason: "too-large" })
      }),
    ),
  )
})
