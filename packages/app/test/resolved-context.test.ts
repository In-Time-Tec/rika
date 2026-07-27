import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import { ContextFileSystem, ContextMentions, FileMentions, ResolvedContext } from "../src/index"
import { provideLayer } from "./layer"

const files = {
  "/work/AGENTS.md": "root",
  "/work/pkg/AGENT.md": "package fallback",
  "/work/pkg/src/AGENTS.md": "source",
  "/work/docs/a.md": "A",
  "/work/docs/b.md": "B",
}
const directories = {
  "/work": ["AGENTS.md", "docs", "pkg"],
  "/work/docs": ["b.md", "a.md"],
  "/work/pkg": ["AGENT.md", "src"],
  "/work/pkg/src": ["AGENTS.md", "main.ts"],
}
const globRegex = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", "\u0000")
      .replaceAll("*", "[^/]*")
      .replaceAll("\u0000", ".*")}$`,
  )
const globFor =
  (fixture: Readonly<Record<string, string>>, order: "sorted" | "reversed" = "sorted"): ResolvedContext.GlobLookup =>
  (workspace, pattern, maximumFiles) => {
    const matched = Object.keys(fixture)
      .filter((name) => name.startsWith(`${workspace}/`))
      .map((name) => name.slice(`${workspace}/`.length))
      .filter((name) => globRegex(pattern).test(name))
      .toSorted()
    return Effect.succeed((order === "sorted" ? matched : matched.toReversed()).slice(0, maximumFiles))
  }
const layerFor = (
  fixtureFiles: Readonly<Record<string, string>>,
  fixtureDirectories: Readonly<Record<string, ReadonlyArray<string>>>,
  order: "sorted" | "reversed" = "sorted",
) =>
  ResolvedContext.layer(globFor(fixtureFiles, order)).pipe(
    Layer.provide(ContextFileSystem.testLayer(fixtureFiles, fixtureDirectories).pipe(Layer.provide(Path.layer))),
    Layer.provide(Path.layer),
    Layer.provide(FileSystem.layerNoop({})),
  )
const spreadFiles = Object.fromEntries(
  ["a", "b"].flatMap((directory) =>
    Array.from({ length: 600 }, (_, index) => [
      `/spread/${directory}/${String(index).padStart(4, "0")}.txt`,
      `${directory}-${index}`,
    ]),
  ),
)
const spreadDirectories = {
  "/spread": ["a", "b"],
  "/spread/a": Array.from({ length: 600 }, (_, index) => `${String(index).padStart(4, "0")}.txt`),
  "/spread/b": Array.from({ length: 600 }, (_, index) => `${String(index).padStart(4, "0")}.txt`),
}
const contextLayer = layerFor(files, directories)

describe("ResolvedContext", () => {
  it.effect("resolves scoped guidance, fallbacks, globs, and stable digests", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const first = yield* resolver.resolve({
        workspace: "/work",
        targetPaths: ["pkg/src/main.ts"],
        references: ["docs/*.md"],
      })
      const second = yield* resolver.resolve({
        workspace: "/work",
        references: ["docs/*.md"],
        targetPaths: ["pkg/src/main.ts"],
      })
      expect(first).toEqual(second)
      expect(first.sources.map((source) => source.path)).toEqual([
        "AGENTS.md",
        "docs/a.md",
        "docs/b.md",
        "pkg/AGENT.md",
        "pkg/src/AGENTS.md",
      ])
      expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    }).pipe(provideLayer(contextLayer)),
  )

  it.effect("diagnoses missing references", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const result = yield* resolver.resolve({ workspace: "/work", references: ["../secret", "missing.md"] })
      expect(result.diagnostics.map((item) => item._tag)).toEqual(["ReferenceNotFound", "ReferenceNotFound"])
    }).pipe(provideLayer(contextLayer)),
  )

  it.effect("diagnoses unreadable selected files and unmatched globs", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const result = yield* resolver.resolve({ workspace: "/work", references: ["AGENTS.md", "none/**/*.md"] })
      expect(result.sources).toEqual([])
      expect(result.diagnostics.map((item) => item._tag)).toEqual(["ReferenceReadFailed", "ReferenceNotFound"])
    }).pipe(
      provideLayer(
        ResolvedContext.layer(globFor(files)).pipe(
          Layer.provide(
            Layer.succeed(ContextFileSystem.Service, {
              exists: (name) => Effect.succeed(name === "/work" || name === "/work/AGENTS.md"),
              realPath: (name) => Effect.succeed(name),
              readDirectory: (name) => Effect.succeed(name === "/work" ? ["AGENTS.md"] : undefined),
              readFileString: (path) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "test",
                    method: "readFileString",
                    pathOrDescriptor: path,
                  }),
                ),
            }),
          ),
          Layer.provide(Path.layer),
          Layer.provide(FileSystem.layerNoop({})),
        ),
      ),
    ),
  )

  it.effect("handles empty input, outside targets, fallback guidance, and non-directory references", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const empty = yield* resolver.resolve({ workspace: "/work" })
      expect(empty.sources.map((source) => source.path)).toEqual(["AGENTS.md"])

      const result = yield* resolver.resolve({
        workspace: "/work",
        targetPaths: ["../outside.ts", "pkg/src/main.ts"],
        references: ["docs/a.md"],
      })
      expect(result.sources.map((source) => [source.path, source.kind])).toEqual([
        ["AGENTS.md", "guidance"],
        ["docs/a.md", "reference"],
        ["pkg/AGENT.md", "guidance"],
        ["pkg/src/AGENTS.md", "guidance"],
      ])
      expect(result.diagnostics.map((item) => item._tag)).toEqual(["PathOutsideWorkspace"])
    }).pipe(provideLayer(contextLayer)),
  )

  it.effect("uses CLAUDE.md when primary guidance names are absent", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const result = yield* resolver.resolve({ workspace: "/other" })
      expect(result.sources.map((source) => source.path)).toEqual(["CLAUDE.md"])
    }).pipe(provideLayer(layerFor({ "/other/CLAUDE.md": "fallback" }, { "/other": ["CLAUDE.md"] }))),
  )

  it.effect("keeps glob traversal inside the workspace and accepts the workspace itself as a target", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const result = yield* resolver.resolve({
        workspace: "/work",
        targetPaths: ["."],
        references: ["**/*.md"],
      })
      expect(result.sources.map((source) => source.path)).toEqual(["AGENTS.md", "docs/nested/reference.md"])
      expect(result.diagnostics).toEqual([])
    }).pipe(
      provideLayer(
        layerFor(
          {
            "/work/AGENTS.md": "guidance",
            "/work/docs/nested/reference.md": "reference",
            "/outside.md": "must not be selected",
          },
          {
            "/work": ["..", "AGENTS.md", "docs"],
            "/work/docs": ["nested"],
            "/work/docs/nested": ["reference.md"],
          },
        ),
      ),
    ),
  )

  it.effect("applies the one thousand file bound globally across glob references", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const result = yield* resolver.resolve({ workspace: "/large", references: ["a/*.txt", "b/*.txt"] })
      expect(result.sources).toHaveLength(1_000)
      expect(result.sources[0]?.path).toBe("a/0000.txt")
      expect(result.sources.at(-1)?.path).toBe("a/0999.txt")
    }).pipe(
      provideLayer(
        layerFor(
          Object.fromEntries(
            ["a", "b"].flatMap((directory) =>
              Array.from({ length: 1_000 }, (_, index) => [
                `/large/${directory}/${String(index).padStart(4, "0")}.txt`,
                `${directory}-${index}`,
              ]),
            ),
          ),
          {
            "/large": ["a", "b"],
            "/large/a": Array.from({ length: 1_000 }, (_, index) => `${String(index).padStart(4, "0")}.txt`),
            "/large/b": Array.from({ length: 1_000 }, (_, index) => `${String(index).padStart(4, "0")}.txt`),
          },
        ),
      ),
    ),
  )

  it.effect("caps glob references by sorted path, not by enumeration order", () =>
    Effect.gen(function* () {
      const paths = (order: "sorted" | "reversed") =>
        Effect.gen(function* () {
          const resolver = yield* ResolvedContext.Service
          const result = yield* resolver.resolve({ workspace: "/spread", references: ["a/*.txt", "b/*.txt"] })
          return result.sources.map((source) => source.path)
        }).pipe(provideLayer(layerFor(spreadFiles, spreadDirectories, order)))
      const forward = yield* paths("sorted")
      const reversed = yield* paths("reversed")

      expect(reversed).toEqual(forward)
      expect(forward).toHaveLength(1_000)
      expect(forward.at(0)).toBe("a/0000.txt")
      expect(forward.at(-1)).toBe("b/0399.txt")
      expect(forward).not.toContain("b/0400.txt")
    }),
  )

  it.effect("follows reference symlinks that leave the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const resolver = yield* ResolvedContext.Service
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-root-" })
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-context-outside-" })
      yield* fileSystem.writeFileString(`${outside}/secret.txt`, "secret")
      yield* fileSystem.symlink(`${outside}/secret.txt`, `${root}/escape.txt`)
      const result = yield* resolver.resolve({ workspace: root, references: ["escape.txt"] })
      expect(result.sources.map((source) => source.content)).toEqual(["secret"])
      expect(result.diagnostics).toEqual([])
    }).pipe(
      provideLayer(
        ResolvedContext.layer(() => Effect.succeed([])).pipe(
          Layer.provide(ContextFileSystem.liveLayer),
          Layer.provideMerge(BunServices.layer),
        ),
      ),
    ),
  )

  it.effect("parses quoted file mentions deterministically", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      expect(FileMentions.resolve("/work", 'see @pkg/a.ts and @"docs/read me.md" @pkg/a.ts', path)).toEqual([
        "/work/docs/read me.md",
        "/work/pkg/a.ts",
      ])
    }).pipe(provideLayer(Path.layer)),
  )

  it("parses typed file, guidance, and image mentions without treating removed thread syntax as supported", () => {
    expect(
      ContextMentions.parse('@thread:T-2 @image:"assets/diagram one.png" @guidance:docs/*.md @file:src/a.ts'),
    ).toEqual({
      files: ["src/a.ts"],
      references: ["docs/*.md"],
      images: ["assets/diagram one.png"],
    })
  })
})
