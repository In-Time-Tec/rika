import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer } from "effect"
import { MediaView, ParallelSearch, ReadWebPage, Runtime } from "../src"
import { provide } from "./test-layer"

test("runs filesystem, shell, and git tools against a bounded workspace", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tools-" })
      yield* fileSystem.makeDirectory(`${workspace}/src`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspace}/node_modules/ignored`, { recursive: true })
      yield* fileSystem.writeFileString(`${workspace}/src/a.ts`, "alpha\nbeta\nalpha")
      yield* fileSystem.writeFileString(`${workspace}/node_modules/ignored/a.ts`, "hidden")
      return yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const found = yield* runtime.run({ _tag: "FindFiles", query: ".ts" })
        const literal = yield* runtime.run({ _tag: "Grep", pattern: "beta", regex: false })
        const regex = yield* runtime.run({ _tag: "Grep", pattern: "^alpha$", regex: true })
        const read = yield* runtime.run({ _tag: "ReadFile", path: "src/a.ts", offset: 1, limit: 1 })
        const created = yield* runtime.run({ _tag: "CreateFile", path: "new/file.txt", content: "old" })
        const duplicate = yield* Effect.result(runtime.run({ _tag: "CreateFile", path: "new/file.txt", content: "x" }))
        const edited = yield* runtime.run({ _tag: "EditFile", path: "new/file.txt", oldText: "old", newText: "new" })
        const stale = yield* Effect.result(
          runtime.run({ _tag: "EditFile", path: "new/file.txt", oldText: "old", newText: "x" }),
        )
        const ambiguous = yield* Effect.result(
          runtime.run({ _tag: "EditFile", path: "src/a.ts", oldText: "alpha", newText: "x" }),
        )
        const shell = yield* runtime.run({ _tag: "Shell", command: "bun", args: ["-e", "console.log('ok')"] })
        yield* runtime.run({ _tag: "Shell", command: "git", args: ["init", "-q"] })
        const git = yield* runtime.run({ _tag: "GitStatus" })
        return { found, literal, regex, read, created, duplicate, edited, stale, ambiguous, shell, git }
      }).pipe(
        provide(
          Runtime.layer(workspace).pipe(
            Layer.provide(MediaView.analyzerTestLayer(() => Effect.succeed("analysis"))),
            Layer.provide(
              Layer.merge(
                ParallelSearch.testLayer(() => Effect.succeed([])),
                ReadWebPage.testLayer(() => Effect.succeed("page")),
              ),
            ),
          ),
        ),
      )
    }),
  )
  return Effect.runPromise(
    Effect.scoped(provide(program, BunServices.layer)).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.found.text).toBe("src/a.ts")
          expect(result.literal.text).toContain("src/a.ts:2:beta")
          expect(result.regex.text.split("\n")).toHaveLength(2)
          expect(result.read.text).toBe("2: beta")
          expect(result.created.text).toBe("created new/file.txt")
          expect(result.edited.text).toBe("edited new/file.txt")
          expect(result.duplicate._tag).toBe("Failure")
          expect(result.stale._tag).toBe("Failure")
          expect(result.ambiguous._tag).toBe("Failure")
          expect(result.shell.text).toBe("ok")
          expect(result.git.text).toContain("No commits yet")
        }),
      ),
    ),
  )
}, 30_000)

test(
  "applies a validated multi-operation patch and leaves files unchanged on validation failure",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-patch-" })
          yield* fileSystem.writeFileString(`${workspace}/a.txt`, "one\ntwo\nthree\n")
          const runtimeLayer = Runtime.layer(workspace).pipe(
            Layer.provide(MediaView.analyzerTestLayer(() => Effect.succeed("analysis"))),
            Layer.provide(
              Layer.merge(
                ParallelSearch.testLayer(() => Effect.succeed([])),
                ReadWebPage.testLayer(() => Effect.succeed("page")),
              ),
            ),
          )
          const result = yield* Effect.gen(function* () {
            const runtime = yield* Runtime.Service
            const applied = yield* runtime.run({
              _tag: "ApplyPatch",
              patchText:
                "*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+changed\n three\n*** Add File: b.txt\n+new\n*** Update File: b.txt\n*** Move to: moved/b.txt\n*** Delete File: a.txt\n*** End Patch\n",
            })
            const moved = yield* fileSystem.readFileString(`${workspace}/moved/b.txt`)
            yield* fileSystem.writeFileString(`${workspace}/stable.txt`, "stable\n")
            const rejected = yield* Effect.result(
              runtime.run({
                _tag: "ApplyPatch",
                patchText:
                  "*** Begin Patch\n*** Add File: transient.txt\n+created\n*** Update File: stable.txt\n@@\n-stale\n+bad\n*** End Patch\n",
              }),
            )
            return {
              applied,
              moved,
              rejected,
              transient: yield* fileSystem.exists(`${workspace}/transient.txt`),
              stable: yield* fileSystem.readFileString(`${workspace}/stable.txt`),
            }
          }).pipe(provide(runtimeLayer))
          expect(result.applied.text).toBe("applied 4 operations")
          expect(result.moved).toBe("new\n")
          expect(result.rejected._tag).toBe("Failure")
          expect(result.transient).toBe(false)
          expect(result.stable).toBe("stable\n")
        }).pipe(provide(BunServices.layer)),
      ),
    ),
  30_000,
)

test("views image metadata and routes documents through the injected analyzer", () => {
  const analyzed: Array<string> = []
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-media-" })
        const png = new Uint8Array(24)
        png.set([0x89, 0x50, 0x4e, 0x47])
        new DataView(png.buffer).setUint32(16, 320)
        new DataView(png.buffer).setUint32(20, 200)
        yield* fileSystem.writeFile(`${workspace}/image.png`, png)
        yield* fileSystem.writeFile(`${workspace}/document.bin`, new TextEncoder().encode("%PDF-1.7\nfixture"))
        yield* fileSystem.writeFileString(`${workspace}/plain.txt`, "plain")
        const oversizedBytes = new Uint8Array(25 * 1024 * 1024 + 1)
        oversizedBytes.set([0x89, 0x50, 0x4e, 0x47])
        yield* fileSystem.writeFile(`${workspace}/oversized.png`, oversizedBytes)
        const runtimeLayer = Runtime.layer(workspace).pipe(
          Layer.provide(
            MediaView.analyzerTestLayer((input) =>
              Effect.sync(() => {
                analyzed.push(`${input.kind}:${input.mimeType}`)
                return "summary"
              }),
            ),
          ),
          Layer.provide(
            Layer.merge(
              ParallelSearch.testLayer(() => Effect.succeed([])),
              ReadWebPage.testLayer(() => Effect.succeed("page")),
            ),
          ),
        )
        const result = yield* Effect.gen(function* () {
          const runtime = yield* Runtime.Service
          const image = yield* runtime.run({ _tag: "ViewMedia", path: "image.png" })
          const document = yield* runtime.run({ _tag: "ViewMedia", path: "document.bin" })
          const missing = yield* Effect.result(runtime.run({ _tag: "ViewMedia", path: "missing.png" }))
          const unsupported = yield* Effect.result(runtime.run({ _tag: "ViewMedia", path: "plain.txt" }))
          const escaped = yield* Effect.result(runtime.run({ _tag: "ViewMedia", path: "../outside.png" }))
          const oversized = yield* Effect.result(runtime.run({ _tag: "ViewMedia", path: "oversized.png" }))
          return { image, document, missing, unsupported, escaped, oversized }
        }).pipe(provide(runtimeLayer))
        expect(result.image.artifact).toMatchObject({ mimeType: "image/png", kind: "image", width: 320, height: 200 })
        expect(result.document).toMatchObject({
          text: "summary",
          artifact: { kind: "pdf", mimeType: "application/pdf" },
        })
        expect(analyzed).toEqual(["pdf:application/pdf"])
        expect(result.missing._tag).toBe("Failure")
        expect(result.unsupported._tag).toBe("Failure")
        expect(result.escaped._tag).toBe("Failure")
        expect(result.oversized._tag).toBe("Failure")
      }).pipe(provide(BunServices.layer)),
    ),
  )
}, 30_000)
