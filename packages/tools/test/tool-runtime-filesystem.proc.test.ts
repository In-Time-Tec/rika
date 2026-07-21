import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { MediaView, ProcessRegistry, ReadWebPage, Runtime, WebSearch, WorkspaceIndex } from "../src"
import { provide } from "./test-layer"

test("exposes fileSearch, glob, and grep through the FFF workspace index", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-index-" })
        yield* fileSystem.makeDirectory(`${workspace}/src`, { recursive: true })
        yield* fileSystem.writeFileString(`${workspace}/src/example.ts`, "alpha\nneedle")
        const result = yield* Effect.gen(function* () {
          const index = yield* WorkspaceIndex.Service
          return {
            files: yield* index.fileSearch("src/exampl.ts", { pageSize: 10 }),
            globbed: yield* index.glob("**/*.ts", { pageSize: 10 }),
            grepped: yield* index.grep("needle", { mode: "plain", pageSize: 10 }),
          }
        }).pipe(provide(WorkspaceIndex.layer(workspace)))
        expect(result.files.items[0]?.relativePath).toBe("src/example.ts")
        expect(result.globbed.items.map((item) => item.relativePath)).toContain("src/example.ts")
        expect(result.grepped.items[0]).toMatchObject({
          relativePath: "src/example.ts",
          lineNumber: 2,
          lineContent: "needle",
        })
      }).pipe(provide(BunServices.layer)),
    ),
  ))

test("runs filesystem, shell, and git tools against a bounded workspace", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tools-" })
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tools-outside-" })
      yield* fileSystem.makeDirectory(`${workspace}/src`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspace}/.hidden`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspace}/node_modules/ignored`, { recursive: true })
      yield* fileSystem.writeFileString(`${workspace}/src/a.ts`, "alpha\nbeta\nalpha")
      yield* fileSystem.writeFileString(`${workspace}/.hidden/a.ts`, "hidden alpha")
      yield* fileSystem.writeFileString(`${workspace}/node_modules/ignored/a.ts`, "hidden")
      yield* fileSystem.symlink(outside, `${workspace}/escaped-cwd`)
      yield* fileSystem.writeFileString(`${outside}/target.txt`, "outside")
      yield* fileSystem.symlink(outside, `${workspace}/link`)
      const result = yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const literal = yield* runtime.run({ _tag: "Grep", pattern: "beta", regex: false })
        const regex = yield* runtime.run({ _tag: "Grep", pattern: "b.ta", regex: true })
        const read = yield* runtime.run({ _tag: "Read", path: "src/a.ts", readRange: [2, 2] })
        const fuzzyRead = yield* runtime.run({ _tag: "Read", path: "src/aa.ts", readRange: [1, 1] })
        const escapedRead = yield* Effect.result(runtime.run({ _tag: "Read", path: "link/target.txt" }))
        const escapedGrep = yield* runtime.run({ _tag: "Grep", pattern: "outside", regex: false })
        const created = yield* runtime.run({ _tag: "Write", path: "new/file.txt", content: "old" })
        const overwritten = yield* runtime.run({ _tag: "Write", path: "new/file.txt", content: "old" })
        const edited = yield* runtime.run({ _tag: "Edit", path: "new/file.txt", oldStr: "old", newStr: "new" })
        const stale = yield* Effect.result(
          runtime.run({ _tag: "Edit", path: "new/file.txt", oldStr: "old", newStr: "x" }),
        )
        const ambiguous = yield* Effect.result(
          runtime.run({ _tag: "Edit", path: "src/a.ts", oldStr: "alpha", newStr: "x" }),
        )
        const symlinkCreate = yield* Effect.result(
          runtime.run({ _tag: "Write", path: "link/new.txt", content: "escaped" }),
        )
        const symlinkEdit = yield* Effect.result(
          runtime.run({ _tag: "Edit", path: "link/target.txt", oldStr: "outside", newStr: "escaped" }),
        )
        const shell = yield* runtime.run({ _tag: "Bash", command: "bun -e \"console.log('ok')\"" })
        const escapedCwd = yield* Effect.result(runtime.run({ _tag: "Bash", command: "pwd", workdir: "escaped-cwd" }))
        yield* runtime.run({ _tag: "Bash", command: "git init -q -b inspection" })
        yield* runtime.run({ _tag: "Bash", command: 'git config user.name "Rika Test"' })
        yield* runtime.run({ _tag: "Bash", command: "git config user.email rika@example.test" })
        yield* runtime.run({ _tag: "Bash", command: "git add src/a.ts" })
        yield* runtime.run({ _tag: "Bash", command: "git commit -qm base" })
        yield* runtime.run({ _tag: "Edit", path: "src/a.ts", oldStr: "beta", newStr: "changed" })
        yield* runtime.run({ _tag: "Write", path: "staged.txt", content: "staged" })
        yield* runtime.run({ _tag: "Bash", command: "git add staged.txt" })
        yield* runtime.run({ _tag: "Write", path: "untracked.txt", content: "untracked" })
        const git = yield* runtime.run({ _tag: "Bash", command: "git --no-optional-locks status --short --branch" })
        return {
          literal,
          regex,
          read,
          fuzzyRead,
          escapedRead,
          escapedGrep,
          created,
          overwritten,
          edited,
          stale,
          ambiguous,
          symlinkCreate,
          symlinkEdit,
          shell,
          escapedCwd,
          git,
        }
      }).pipe(
        provide(
          Runtime.layer(workspace).pipe(
            Layer.provide(MediaView.analyzerTestLayer(() => Effect.succeed("analysis"))),
            Layer.provide(
              Layer.merge(
                WebSearch.testLayer(() => Effect.succeed([])),
                ReadWebPage.testLayer(() => Effect.succeed("page")),
              ),
            ),
          ),
        ),
      )
      return { ...result, outside: yield* fileSystem.readFileString(`${outside}/target.txt`) }
    }),
  )
  return Effect.runPromise(
    Effect.scoped(provide(program, BunServices.layer)).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.literal.text).toContain("src/a.ts:2:beta")
          expect(result.regex.text).toContain("src/a.ts:2:beta")
          expect(result.read.text).toBe("2: beta")
          expect(result.fuzzyRead.text).toBe("1: alpha")
          expect(result.escapedRead._tag).toBe("Failure")
          expect(result.escapedGrep.text).toBe("")
          expect(result.created.text).toBe("Successfully wrote 3 bytes to new/file.txt")
          expect(result.edited.text).toBe("Successfully replaced text in new/file.txt")
          expect(result.overwritten.text).toBe("Successfully wrote 3 bytes to new/file.txt")
          expect(result.stale._tag).toBe("Failure")
          expect(result.ambiguous._tag).toBe("Failure")
          expect(result.symlinkCreate._tag).toBe("Failure")
          expect(result.symlinkEdit._tag).toBe("Failure")
          expect(result.outside).toBe("outside")
          expect(result.shell.text).toBe("ok")
          expect(result.escapedCwd._tag).toBe("Failure")
          if (result.escapedCwd._tag === "Failure")
            expect(String(result.escapedCwd.failure)).toContain("escapes workspace")
          expect(result.git.text).toContain("## inspection")
          expect(result.git.text).toContain(" M src/a.ts")
          expect(result.git.text).toContain("A  staged.txt")
          expect(result.git.text).toContain("?? untracked.txt")
        }),
      ),
    ),
  )
}, 30_000)

test("sends SIGTERM to a live shell process when the registry scope closes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-process-signal-" })
        const marker = `${workspace}/terminated`
        const encodedMarker = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(marker)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* ProcessRegistry.Service
            const processId = yield* registry.start(
              "bun",
              [
                "-e",
                `process.on("SIGTERM",()=>{require("node:fs").writeFileSync(${encodedMarker},"terminated");process.exit(0)});console.log("ready");setInterval(()=>{},1000)`,
              ],
              workspace,
            )
            expect(yield* registry.poll(processId, 1_000, 100)).toMatchObject({ stdout: "ready\n", running: true })
          }).pipe(provide(ProcessRegistry.layer)),
        )
        for (let attempt = 0; attempt < 100 && !(yield* fileSystem.exists(marker)); attempt += 1)
          yield* Effect.sleep("10 millis")
        expect(yield* fileSystem.readFileString(marker)).toBe("terminated")
      }).pipe(provide(BunServices.layer)),
    ),
  ))

test("bounds grep results to one thousand matches", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tools-grep-bound-" })
        const content = "needle\n".repeat(600)
        yield* fileSystem.writeFileString(`${workspace}/one.txt`, content)
        yield* fileSystem.writeFileString(`${workspace}/two.txt`, content)
        const result = yield* Effect.gen(function* () {
          const runtime = yield* Runtime.Service
          return yield* runtime.run({ _tag: "Grep", pattern: "needle", regex: false })
        }).pipe(
          provide(
            Runtime.layer(workspace).pipe(
              Layer.provide(MediaView.analyzerTestLayer(() => Effect.succeed("analysis"))),
              Layer.provide(
                Layer.merge(
                  WebSearch.testLayer(() => Effect.succeed([])),
                  ReadWebPage.testLayer(() => Effect.succeed("page")),
                ),
              ),
            ),
          ),
        )
        expect(result.text.split("\n")).toHaveLength(1_000)
      }).pipe(provide(BunServices.layer)),
    ),
  ))

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
              WebSearch.testLayer(() => Effect.succeed([])),
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
