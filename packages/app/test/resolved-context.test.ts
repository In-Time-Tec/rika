import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path, PlatformError } from "effect"
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
const contextLayer = ResolvedContext.layer.pipe(
  Layer.provide(ContextFileSystem.testLayer(files, directories).pipe(Layer.provide(Path.layer))),
  Layer.provide(Path.layer),
)

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

  it.effect("diagnoses escaping and missing references", () =>
    Effect.gen(function* () {
      const resolver = yield* ResolvedContext.Service
      const result = yield* resolver.resolve({ workspace: "/work", references: ["../secret", "missing.md"] })
      expect(result.diagnostics.map((item) => item._tag)).toEqual(["PathOutsideWorkspace", "ReferenceNotFound"])
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
        ResolvedContext.layer.pipe(
          Layer.provide(
            Layer.succeed(ContextFileSystem.Service, {
              exists: (name) => Effect.succeed(name === "/work" || name === "/work/AGENTS.md"),
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
    }).pipe(
      provideLayer(
        ResolvedContext.layer.pipe(
          Layer.provide(
            ContextFileSystem.testLayer({ "/other/CLAUDE.md": "fallback" }, { "/other": ["CLAUDE.md"] }).pipe(
              Layer.provide(Path.layer),
            ),
          ),
          Layer.provide(Path.layer),
        ),
      ),
    ),
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
        ResolvedContext.layer.pipe(
          Layer.provide(
            ContextFileSystem.testLayer(
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
            ).pipe(Layer.provide(Path.layer)),
          ),
          Layer.provide(Path.layer),
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

  it("parses typed file, guidance, thread, and image mentions without collisions", () => {
    expect(
      ContextMentions.parse('@thread:T-2 @image:"assets/diagram one.png" @guidance:docs/*.md @file:src/a.ts'),
    ).toEqual({
      files: ["src/a.ts"],
      references: ["docs/*.md"],
      threads: ["T-2"],
      images: ["assets/diagram one.png"],
    })
  })
})
