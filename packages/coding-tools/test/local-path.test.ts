import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect"
import { LocalPath } from "@rika/coding-tools/coding-tool-catalog"
import { provide } from "./test-layer"

const lookup = (fileSystem: FileSystem.FileSystem): LocalPath.Lookup => ({
  exists: (path) => fileSystem.exists(path),
  readDirectory: (path) => fileSystem.readDirectory(path),
})

const inWorkspace = <A, E>(
  build: (fileSystem: FileSystem.FileSystem, workspace: string) => Effect.Effect<unknown, PlatformError.PlatformError>,
  use: (lookup: LocalPath.Lookup, options: LocalPath.Options, fileSystem: FileSystem.FileSystem) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-path-" })
      yield* build(fileSystem, workspace).pipe(Effect.orDie)
      return yield* use(lookup(fileSystem), { path, base: workspace }, fileSystem)
    }),
  ).pipe(provide(BunServices.layer))

describe("LocalPath", () => {
  it.effect("resolves an exact path unchanged", () =>
    Effect.gen(function* () {
      const resolved = yield* inWorkspace(
        (fileSystem, workspace) => fileSystem.writeFileString(`${workspace}/file.ts`, "x"),
        (found, options) => LocalPath.resolveExistingPath(found, "file.ts", options),
      )
      expect(resolved.endsWith("/file.ts")).toBe(true)
    }),
  )

  it.effect("corrects casing across several segments", () =>
    Effect.gen(function* () {
      const content = yield* inWorkspace(
        (fileSystem, workspace) =>
          fileSystem
            .makeDirectory(`${workspace}/src/Components`, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(`${workspace}/src/Components/Button.ts`, "button"))),
        (found, options, fileSystem) =>
          LocalPath.resolveExistingPath(found, "SRC/components/button.ts", options).pipe(
            Effect.flatMap((resolved) => fileSystem.readFileString(resolved)),
          ),
      )
      expect(content).toBe("button")
    }),
  )

  it.effect("resolves an absolute path outside the base", () =>
    Effect.gen(function* () {
      const resolved = yield* inWorkspace(
        (fileSystem, workspace) => fileSystem.writeFileString(`${workspace}/outside.ts`, "x"),
        (found, options) =>
          LocalPath.resolveExistingPath(found, `${options.base}/outside.ts`, {
            ...options,
            base: `${options.base}/nested`,
          }),
      )
      expect(resolved.endsWith("/outside.ts")).toBe(true)
    }),
  )

  it.effect("expands a leading home reference", () =>
    Effect.gen(function* () {
      const resolved = yield* inWorkspace(
        (fileSystem, workspace) => fileSystem.writeFileString(`${workspace}/dotfile`, "x"),
        (found, options) => LocalPath.resolveExistingPath(found, "~/dotfile", { ...options, home: options.base }),
      )
      expect(resolved.endsWith("/dotfile")).toBe(true)
    }),
  )

  it.effect("fails when a path does not exist in any casing", () =>
    Effect.gen(function* () {
      const failure = yield* inWorkspace(
        () => Effect.void,
        (found, options) => LocalPath.resolveExistingPath(found, "missing.ts", options),
      ).pipe(Effect.flip)
      expect(Schema.is(LocalPath.LocalPathError)(failure)).toBe(true)
      if (Schema.is(LocalPath.LocalPathError)(failure)) expect(failure.reason).toBe("not_found")
    }),
  )

  it.effect("fails when two case variants match", () =>
    Effect.gen(function* () {
      const outcome = yield* inWorkspace(
        (fileSystem, workspace) =>
          fileSystem
            .writeFileString(`${workspace}/Readme.md`, "x")
            .pipe(Effect.andThen(fileSystem.writeFileString(`${workspace}/README.md`, "y"))),
        (found, options, fileSystem) =>
          Effect.gen(function* () {
            const entries = yield* fileSystem.readDirectory(options.base).pipe(Effect.orDie)
            if (entries.length < 2) return "case-insensitive"
            return yield* LocalPath.resolveExistingPath(found, "readme.md", options).pipe(Effect.flip)
          }),
      )
      if (outcome === "case-insensitive") return
      expect(Schema.is(LocalPath.LocalPathError)(outcome)).toBe(true)
      if (Schema.is(LocalPath.LocalPathError)(outcome)) {
        expect(outcome.reason).toBe("ambiguous_case")
        expect(outcome.candidates.length).toBe(2)
      }
    }),
  )

  it.effect("prefers an exact match over a case variant", () =>
    Effect.gen(function* () {
      const resolved = yield* inWorkspace(
        (fileSystem, workspace) =>
          fileSystem
            .writeFileString(`${workspace}/Notes.md`, "upper")
            .pipe(Effect.andThen(fileSystem.writeFileString(`${workspace}/notes.md`, "lower"))),
        (found, options) => LocalPath.resolveExistingPath(found, "notes.md", options),
      )
      expect(resolved.endsWith("/notes.md")).toBe(true)
    }),
  )

  it.effect("write target overwrites an existing file reached through a case variant", () =>
    Effect.gen(function* () {
      const listed = yield* inWorkspace(
        (fileSystem, workspace) =>
          fileSystem
            .makeDirectory(`${workspace}/src`, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(`${workspace}/src/File.ts`, "x"))),
        (found, options, fileSystem) =>
          LocalPath.resolveWriteTarget(found, "SRC/file.ts", options).pipe(
            Effect.tap((resolved) => fileSystem.writeFileString(resolved, "replaced")),
            Effect.andThen(fileSystem.readDirectory(`${options.base}/src`)),
          ),
      )
      expect(listed).toEqual(["File.ts"])
    }),
  )

  it.effect("write target keeps the requested spelling for a new file", () =>
    Effect.gen(function* () {
      const listed = yield* inWorkspace(
        (fileSystem, workspace) => fileSystem.makeDirectory(`${workspace}/src`, { recursive: true }),
        (found, options, fileSystem) =>
          LocalPath.resolveWriteTarget(found, "SRC/NewFile.ts", options).pipe(
            Effect.tap((resolved) => fileSystem.writeFileString(resolved, "fresh")),
            Effect.andThen(fileSystem.readDirectory(options.base)),
          ),
      )
      expect(listed).toEqual(["src"])
    }),
  )

  it.effect("write target creates missing parents under the requested spelling", () =>
    Effect.gen(function* () {
      const resolved = yield* inWorkspace(
        () => Effect.void,
        (found, options) => LocalPath.resolveWriteTarget(found, "fresh/nested/file.ts", options),
      )
      expect(resolved.endsWith("/fresh/nested/file.ts")).toBe(true)
    }),
  )
})
