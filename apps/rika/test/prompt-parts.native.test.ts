import * as BunServices from "@effect/platform-bun/BunServices"
import { afterEach, expect, test } from "vitest"
import { Config, Data, Effect, FileSystem, Layer, Path, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ViewState } from "@rika/tui"
import {
  defaultOpenArguments,
  initialSubmitAction,
  imagePasteBlockedNotice,
  materializePromptParts,
  parseChangedFiles,
  pasteClipboardPng,
  pastedImagePath,
  persistPastedImage,
  readChangedFiles,
  refreshChangedFilesOn,
  resolveWorkspaceFile,
} from "../src/main"

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly operation: string; readonly cause: unknown }> {}

const workspaces: Array<string> = []

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

const command = (name: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return yield* spawner.exitCode(ChildProcess.make(name, args))
  })

test("reports why image paste is blocked while editing a queued turn", () => {
  expect(
    imagePasteBlockedNotice({
      ...ViewState.initial("/work"),
      editingTurnId: "queued-turn",
    }),
  ).toBe("Images cannot be pasted while editing a queued prompt")
  expect(imagePasteBlockedNotice(ViewState.initial("/work"))).toBeUndefined()
})

afterEach(() =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* Effect.forEach(workspaces.splice(0), (workspace) => fileSystem.remove(workspace, { recursive: true }), {
        discard: true,
      })
    }),
  ),
)

const workspace = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
    const directory = yield* fileSystem.makeTempDirectory({ directory: temporaryDirectory, prefix })
    workspaces.push(directory)
    return directory
  })

test("materializes ordered text and dropped image paths for submission", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-prompt-parts-")
      yield* fileSystem.writeFile(path.join(root, "relative image.png"), Uint8Array.from([1, 2, 3]))
      yield* fileSystem.writeFile(path.join(root, "url image.webp"), Uint8Array.from([4, 5]))
      const prompt = `before relative\\ image.png middle file://${root}/url%20image.webp after`
      expect(yield* materializePromptParts(ViewState.promptParts(prompt), root)).toEqual([
        { type: "text", text: "before " },
        { type: "image", mediaType: "image/png", data: "AQID", filename: "relative image.png" },
        { type: "text", text: " middle " },
        { type: "image", mediaType: "image/webp", data: "BAU=", filename: `${root}/url image.webp` },
        { type: "text", text: " after" },
      ])
    }),
  ))

test("materializes exact precomputed pasted text and image parts without reparsing text", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-prompt-parts-")
      yield* fileSystem.writeFile(path.join(root, "shot.png"), Uint8Array.from([1, 2, 3]))
      const input = [
        { type: "text", text: "pasted line one\npasted [not-an-attachment.png] line two" },
        { type: "image", path: "shot.png" },
      ] as const
      expect(yield* materializePromptParts(input, root)).toEqual([
        input[0],
        { type: "image", mediaType: "image/png", data: "AQID", filename: "shot.png" },
      ])
    }),
  ))

test("preserves expanded text-only paste parts instead of falling back to the composer token", () =>
  run(
    Effect.gen(function* () {
      const token = String.fromCharCode(0xe000)
      const model = ViewState.update(
        { ...ViewState.initial("/work"), input: "before ", cursor: 7 },
        { _tag: "Pasted", text: "first line\nsecond line" },
      )
      const completed = ViewState.update(model, {
        _tag: "KeyPressed",
        key: { name: "x", sequence: " after", ctrl: false, alt: false, meta: false, shift: false, eventType: "press" },
      })
      expect(completed.input).toBe(`before ${token} after`)
      expect(
        yield* materializePromptParts(ViewState.promptParts(completed.input, completed.pastedText), "/work"),
      ).toEqual([{ type: "text", text: "before first line\nsecond line after" }])
    }),
  ))

test("builds the initial interactive submission from CLI prompt words and selected mode", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(initialSubmitAction([], "medium")).toBeUndefined()
      expect(initialSubmitAction(["inspect", "this.png"], "ultra")).toEqual({
        _tag: "Submit",
        prompt: "inspect this.png",
        parts: [
          { type: "text", text: "inspect " },
          { type: "image", path: "this.png" },
        ],
        mode: "ultra",
      })
      yield* Effect.void
    }),
  ))

test("parses nested changed paths, rename destinations, and diff counts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        parseChangedFiles(
          "?? apps/rika/src/new file.ts\0 M packages/tui/src/adapter.ts\0R  docs/new -> name.ts\0old.ts\0?? odd\tline\nname.ts\0",
          ["4\t1\tpackages/tui/src/adapter.ts", "2\t0\t", "old.ts", "docs/new -> name.ts", ""].join("\0"),
        ),
      ).toEqual([
        { path: "apps/rika/src/new file.ts", status: "??" },
        { path: "packages/tui/src/adapter.ts", status: "M", added: 4, removed: 1 },
        { path: "docs/new -> name.ts", status: "R", added: 2, removed: 0 },
        { path: "odd\tline\nname.ts", status: "??" },
      ])
      yield* Effect.void
    }),
  ))

test("opens files with the platform default application when no editor is configured", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(defaultOpenArguments("/work/file.ts", "darwin")).toEqual(["open", "/work/file.ts"])
      expect(defaultOpenArguments("/work/file.ts", "linux")).toEqual(["xdg-open", "/work/file.ts"])
      expect(defaultOpenArguments("C:\\work\\file.ts", "win32")).toEqual([
        "cmd",
        "/c",
        "start",
        "",
        "C:\\work\\file.ts",
      ])
      yield* Effect.void
    }),
  ))

test("rejects workspace symlinks that resolve outside the workspace before opening", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-path-root-")
      const outsideRoot = yield* workspace("rika-path-outside-")
      const outside = path.join(outsideRoot, "outside.ts")
      yield* fileSystem.writeFileString(outside, "private\ncontent\n")
      yield* fileSystem.symlink(outside, path.join(root, "link.ts"))
      const resolved = yield* Effect.exit(resolveWorkspaceFile(root, { path: "link.ts" }))
      expect(resolved).toMatchObject({ _tag: "Failure" })
    }),
  ))

test("loads tracked counts from a repository without HEAD and omits untracked counts", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-unborn-head-")
      yield* command("git", "init", "-q", root)
      yield* fileSystem.writeFileString(path.join(root, "staged.ts"), "one\ntwo\nthree\n")
      yield* fileSystem.writeFileString(path.join(root, "untracked.ts"), "one\ntwo")
      yield* command("git", "-C", root, "add", "staged.ts")
      expect(yield* readChangedFiles(root)).toEqual([
        { path: "staged.ts", status: "A", added: 3, removed: 0 },
        { path: "untracked.ts", status: "??" },
      ])
    }),
  ))

test("does not read untracked file contents while listing changed files", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-untracked-files-")
      yield* command("git", "init", "-q", root)
      const paths = Array.from({ length: 256 }, (_, index) => `untracked-${index}.ts`)
      yield* Effect.forEach(
        paths,
        (relative) => fileSystem.writeFileString(path.join(root, relative), "one\ntwo\nthree\n"),
        { concurrency: 16, discard: true },
      )
      let readFileCalls = 0
      const countingFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        readFile: (filename) => {
          readFileCalls += 1
          return fileSystem.readFile(filename)
        },
      }

      const changed = yield* readChangedFiles(root).pipe(
        Effect.provideService(FileSystem.FileSystem, countingFileSystem),
      )
      expect(changed).toHaveLength(paths.length)
      expect(readFileCalls).toBe(0)
      expect(changed.every((file) => file.added === undefined && file.removed === undefined)).toBe(true)
    }),
  ))

test("refreshes changed files once per watcher burst and never while idle or closed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let refreshes = 0
      const refresh = Effect.sync(() => {
        refreshes += 1
      })

      yield* refreshChangedFilesOn(Stream.empty, () => true, refresh)
      expect(refreshes).toBe(0)

      yield* refreshChangedFilesOn(
        Stream.fromIterable(Array.from({ length: 500 }, (_, index) => index)),
        () => true,
        refresh,
      )
      expect(refreshes).toBe(1)

      yield* refreshChangedFilesOn(Stream.make(1), () => false, refresh)
      expect(refreshes).toBe(1)
    }),
  ))

test("parses the exact NUL-delimited output from a real Git repository", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner
      const root = yield* workspace("rika-changed-files-")
      yield* command("git", "init", "-q", root)
      yield* command("git", "-C", root, "config", "user.email", "test@example.com")
      yield* command("git", "-C", root, "config", "user.name", "Test")
      yield* fileSystem.writeFileString(path.join(root, "old name.ts"), "one\ntwo\nthree\n")
      yield* command("git", "-C", root, "add", ".")
      yield* command("git", "-C", root, "commit", "-qm", "initial")
      yield* fileSystem.makeDirectory(path.join(root, "docs", "nested"), { recursive: true })
      yield* fileSystem.makeDirectory(path.join(root, "untracked", "deep"), { recursive: true })
      yield* command("git", "-C", root, "mv", "old name.ts", "docs/nested/new -> name.ts")
      yield* fileSystem.writeFileString(path.join(root, "untracked", "deep", "file with spaces.ts"), "new")
      const status = yield* spawner.string(
        ChildProcess.make("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      )
      const numstat = yield* spawner.string(
        ChildProcess.make("git", ["-C", root, "diff", "--numstat", "-z", "-M", "HEAD"]),
      )
      expect(parseChangedFiles(status, numstat)).toEqual([
        { path: "docs/nested/new -> name.ts", status: "R", added: 0, removed: 0 },
        { path: "untracked/deep/file with spaces.ts", status: "??" },
      ])
    }),
  ))

test("extracts a clipboard image in a fresh workspace with the path passed outside AppleScript", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika clipboard-'-")
      let receivedScript = ""
      let receivedPath = ""
      const relative = yield* pasteClipboardPng(
        root,
        () => 42,
        (script, destination) => {
          receivedScript = script
          receivedPath = destination
          return fileSystem.writeFile(destination, Uint8Array.from([1, 2, 3])).pipe(Effect.as(0))
        },
      )
      expect(relative).toBe(".rika/pasted/paste-42.png")
      expect(receivedPath).toBe(path.join(root, relative!))
      expect(receivedScript).toContain("POSIX file (item 1 of argv)")
      expect(receivedScript).not.toContain(root)
      expect(yield* fileSystem.exists(receivedPath)).toBe(true)
    }),
  ))

test("persists terminal image paste bytes with their media type", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-pasted-image-")
      const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
      const relative = pastedImagePath(
        bytes,
        "IMAGE/WEBP",
        () => 42,
        () => "00000000-0000-0000-0000-000000000001",
      )
      expect(relative).toBe(".rika/pasted/paste-42-00000000-0000-0000-0000-000000000001.webp")
      if (relative === undefined) return yield* new TestFailure({ operation: "create WebP path", cause: relative })
      expect(yield* persistPastedImage(root, relative, bytes)).toBe(true)
      expect(Array.from(yield* fileSystem.readFile(path.join(root, relative)))).toEqual(Array.from(bytes))
    }),
  ))

test("rejects unsupported, unrecognized, and mismatched terminal image bytes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(
        pastedImagePath(
          png,
          "image/png",
          () => 1,
          () => "00000000-0000-0000-0000-000000000002",
        ),
      ).toBe(".rika/pasted/paste-1-00000000-0000-0000-0000-000000000002.png")
      expect(pastedImagePath(png, "image/jpeg")).toBeUndefined()
      expect(pastedImagePath(Uint8Array.from([1, 2, 3]), "image/png")).toBeUndefined()
      expect(pastedImagePath(new TextEncoder().encode("<svg/>"), "image/svg+xml")).toBeUndefined()
      yield* Effect.void
    }),
  ))

test.each([
  ["failed", 1, Uint8Array.from([1])],
  ["empty", 0, new Uint8Array()],
])("removes %s clipboard extraction output", (_name, exit, output) =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-clipboard-")
      const absolute = path.join(root, ".rika", "pasted", "paste-7.png")
      const relative = yield* pasteClipboardPng(
        root,
        () => 7,
        (_script, destination) => fileSystem.writeFile(destination, output).pipe(Effect.as(exit)),
      )
      expect(relative).toBeUndefined()
      expect(yield* fileSystem.exists(absolute)).toBe(false)
    }),
  ),
)

test("removes clipboard output when extraction throws", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* workspace("rika-clipboard-")
      const absolute = path.join(root, ".rika", "pasted", "paste-9.png")
      const relative = yield* pasteClipboardPng(
        root,
        () => 9,
        () => Effect.fail(new TestFailure({ operation: "extract clipboard", cause: "unavailable" })),
      )
      expect(relative).toBeUndefined()
      expect(yield* fileSystem.exists(absolute)).toBe(false)
    }),
  ))
