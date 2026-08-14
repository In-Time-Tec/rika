import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as WorkspaceIndex from "@rika/coding-tools/workspace-file-search"
import { provide } from "./test-layer"

test("searches workspace files with ripgrep without escaping the workspace", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-index-" })
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-index-outside-" })
        yield* fileSystem.makeDirectory(`${workspace}/src`, { recursive: true })
        yield* fileSystem.makeDirectory(`${workspace}/node_modules/ignored`, { recursive: true })
        yield* fileSystem.writeFileString(`${workspace}/src/example.ts`, "alpha needle\nBeta value")
        yield* fileSystem.writeFileString(`${workspace}/src/second.ts`, "alpha other")
        yield* fileSystem.writeFileString(`${workspace}/src/third.ts`, "nothing")
        yield* fileSystem.writeFileString(`${workspace}/node_modules/ignored/package.ts`, "needle ignored")
        yield* fileSystem.writeFileString(`${outside}/escaped.ts`, "needle escaped")
        yield* fileSystem.symlink(outside, `${workspace}/external`)

        yield* Effect.gen(function* () {
          const index = yield* WorkspaceIndex.Service
          const fuzzy = yield* index.fileSearch("src/exampl.ts", { pageSize: 10 })
          const globbed = yield* index.glob("**/*.ts", { pageSize: 10 })
          const plain = yield* index.grep("needle", { mode: "plain", pageSize: 10 })
          const scoped = yield* index.grep("alpha", { mode: "plain", pageSize: 10, include: "src/second.ts" })
          const regex = yield* index.grep("B.ta\\svalue", { mode: "regex", pageSize: 10 })
          const firstPage = yield* index.glob("src/*.ts", { pageIndex: 0, pageSize: 2 })
          const secondPage = yield* index.glob("src/*.ts", { pageIndex: 1, pageSize: 2 })

          expect(fuzzy.items[0]?.relativePath).toBe("src/example.ts")
          expect(fuzzy.scores).toHaveLength(fuzzy.items.length)
          expect(globbed.items.map((item) => item.relativePath)).toEqual([
            "src/example.ts",
            "src/second.ts",
            "src/third.ts",
          ])
          expect(plain.items).toEqual([
            expect.objectContaining({
              relativePath: "src/example.ts",
              lineNumber: 1,
              lineContent: "alpha needle",
            }),
          ])
          expect(regex.items).toEqual([
            expect.objectContaining({ relativePath: "src/example.ts", lineNumber: 2, lineContent: "Beta value" }),
          ])
          expect(scoped.items).toEqual([
            expect.objectContaining({ relativePath: "src/second.ts", lineNumber: 1, lineContent: "alpha other" }),
          ])
          expect(firstPage).toMatchObject({ totalMatched: 3, totalFiles: 3 })
          expect(firstPage.items).toHaveLength(2)
          expect(firstPage.scores).toHaveLength(2)
          expect(secondPage.items).toHaveLength(1)
          expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.relativePath)).size).toBe(3)
          expect(plain).toHaveProperty("nextCursor")
          expect(plain.items.some((item) => item.relativePath.includes("escaped"))).toBe(false)
          expect(globbed.items.some((item) => item.relativePath.includes("external"))).toBe(false)
          expect(fuzzy.items.some((item) => item.relativePath.includes("external"))).toBe(false)

          yield* fileSystem.writeFileString(`${workspace}/src/created.ts`, "created after scan")
          const observed = yield* index.fileSearch("created.ts", { pageSize: 10 })
          expect(observed.items.some((item) => item.relativePath === "src/created.ts")).toBe(true)
        }).pipe(provide(WorkspaceIndex.layer(workspace)))
      }).pipe(provide(BunServices.layer)),
    ),
  ))

test("falls back to owned workspace search when ripgrep is absent", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-fallback-" })
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-fallback-outside-" })
        yield* fileSystem.makeDirectory(`${workspace}/src`, { recursive: true })
        yield* fileSystem.makeDirectory(`${workspace}/node_modules/ignored`, { recursive: true })
        yield* fileSystem.writeFileString(`${workspace}/src/example.ts`, "alpha needle\nBeta value")
        yield* fileSystem.writeFileString(`${workspace}/src/second.ts`, "alpha other")
        yield* fileSystem.writeFileString(`${workspace}/node_modules/ignored/package.ts`, "needle ignored")
        yield* fileSystem.writeFileString(`${outside}/escaped.ts`, "needle escaped")
        yield* fileSystem.symlink(outside, `${workspace}/external`)

        let attempts = 0
        const missingSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            attempts += 1
            return Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "WorkspaceIndexTest",
                method: "spawn",
                pathOrDescriptor: "rg",
              }),
            )
          }),
        )
        const fallback = WorkspaceIndex.layer(workspace).pipe(
          Layer.provide(missingSpawner),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const index = yield* WorkspaceIndex.Service
          const fuzzy = yield* index.fileSearch("src/exampl.ts", { pageSize: 10 })
          const globbed = yield* index.glob("src/*.ts", { pageSize: 10 })
          const plain = yield* index.grep("needle", { mode: "plain", pageSize: 10 })
          const regex = yield* index.grep("B.ta\\svalue", { mode: "regex", pageSize: 10 })
          const scoped = yield* index.grep("alpha", {
            mode: "plain",
            include: "src/second.ts",
            pageSize: 10,
          })

          expect(attempts).toBeGreaterThanOrEqual(5)
          expect(fuzzy.items.map((item) => item.relativePath)).toContain("src/example.ts")
          expect(globbed.items.map((item) => item.relativePath)).toEqual(["src/example.ts", "src/second.ts"])
          expect(plain.items).toEqual([{ relativePath: "src/example.ts", lineNumber: 1, lineContent: "alpha needle" }])
          expect(regex.items).toEqual([{ relativePath: "src/example.ts", lineNumber: 2, lineContent: "Beta value" }])
          expect(scoped.items).toEqual([{ relativePath: "src/second.ts", lineNumber: 1, lineContent: "alpha other" }])
          expect(plain.items.some((item) => item.relativePath.includes("node_modules"))).toBe(false)
          expect(plain.items.some((item) => item.relativePath.includes("escaped"))).toBe(false)
        }).pipe(provide(fallback))
      }).pipe(provide(BunServices.layer)),
    ),
  ))

test("does not hide non-missing ripgrep spawn failures behind the fallback", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-denied-rg-" })
        yield* fileSystem.writeFileString(`${workspace}/proof.txt`, "needle")
        let attempts = 0
        const deniedSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            attempts += 1
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "WorkspaceIndexTest",
                method: "spawn",
                pathOrDescriptor: "rg",
              }),
            )
          }),
        )
        const denied = WorkspaceIndex.layer(workspace).pipe(
          Layer.provide(deniedSpawner),
          Layer.provide(BunServices.layer),
        )
        const failure = yield* Effect.gen(function* () {
          const index = yield* WorkspaceIndex.Service
          return yield* Effect.flip(index.grep("needle", { mode: "plain" }))
        }).pipe(provide(denied))
        expect(attempts).toBe(1)
        expect(failure).toMatchObject({ _tag: "WorkspaceIndexError", operation: "grep" })
        expect(failure.message).toContain("PermissionDenied")
        expect(failure.message).not.toContain("not installed")
      }).pipe(provide(BunServices.layer)),
    ),
  ))
