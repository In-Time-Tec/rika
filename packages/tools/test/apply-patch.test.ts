import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, PlatformError } from "effect"
import { ApplyPatch } from "../src"
import { provide } from "./test-layer"

const run = (
  patchText: string,
  setup: (
    fileSystem: FileSystem.FileSystem,
    workspace: string,
  ) => Effect.Effect<void, PlatformError.PlatformError> = () => Effect.void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-apply-" })
      yield* setup(fileSystem, workspace)
      return yield* ApplyPatch.apply(workspace, patchText, fileSystem, path)
    }),
  ).pipe(provide(BunServices.layer))

const failure = (patchText: string, setup?: Parameters<typeof run>[1]) => Effect.flip(run(patchText, setup))

describe("ApplyPatch", () => {
  it.effect("adds, updates with multiple hunks, moves, and deletes atomically", () =>
    Effect.gen(function* () {
      const result = yield* run(
        "*** Begin Patch\n*** Add File: empty.txt\n*** Add File: new.txt\n+first\n+second\n*** Update File: old.txt\n@@ heading\n one\n-two\n+changed\n@@ tail\n three\n-four\n+last\n*** Update File: new.txt\n*** Move to: nested/moved.txt\n*** Delete File: gone.txt\n*** End Patch\n",
        (fs, workspace) =>
          Effect.all([
            fs.writeFileString(`${workspace}/old.txt`, "one\ntwo\nthree\nfour\n"),
            fs.writeFileString(`${workspace}/gone.txt`, "gone"),
          ]).pipe(Effect.asVoid),
      )
      expect(result).toMatchObject({ text: "applied 5 operations", truncated: false })
      expect(result.diff).toContain("+++ b/")
    }),
  )

  it("parses all operation forms and optional trailing newline", () => {
    expect(ApplyPatch.parse("*** Begin Patch\n*** Delete File: a\n*** End Patch")).toEqual([
      { kind: "delete", path: "a" },
    ])
    expect(ApplyPatch.parse("*** Begin Patch\n*** Update File: a\n*** Move to: b\n*** End Patch\n")).toEqual([
      { kind: "update", path: "a", moveTo: "b", hunks: [] },
    ])
    expect(
      ApplyPatch.parse("*** Begin Patch\n*** Update File: a\n@@\n old\n*** End of File\n*** End Patch\n"),
    ).toHaveLength(1)
  })

  it.effect("reports a singular operation", () =>
    Effect.gen(function* () {
      expect((yield* run("*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n")).text).toBe("applied 1 operation")
    }),
  )

  const invalid = [
    ["bad envelope", "nope"],
    ["no operations", "*** Begin Patch\n*** End Patch"],
    ["bad header", "*** Begin Patch\nwat\n*** End Patch"],
    ["bad add line", "*** Begin Patch\n*** Add File: a\nwrong\n*** End Patch"],
    ["missing update body", "*** Begin Patch\n*** Update File: a\n*** End Patch"],
    ["bad hunk header", "*** Begin Patch\n*** Update File: a\nwrong\n*** End Patch"],
    ["bad hunk line", "*** Begin Patch\n*** Update File: a\n@@\nwrong\n*** End Patch"],
    ["empty hunk", "*** Begin Patch\n*** Update File: a\n@@\n*** End Patch"],
  ] as const
  for (const [name, patch] of invalid) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* failure(patch)
        expect(error._tag).toBe("ApplyPatchError")
      }),
    )
  }

  const rejected = [
    ["workspace root", "*** Begin Patch\n*** Add File: .\n+x\n*** End Patch\n", undefined],
    ["escaping path", "*** Begin Patch\n*** Add File: ../x\n+x\n*** End Patch\n", undefined],
    [
      "existing add",
      "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n",
      (fs: FileSystem.FileSystem, root: string) => fs.writeFileString(`${root}/a`, "old"),
    ],
    ["missing delete", "*** Begin Patch\n*** Delete File: a\n*** End Patch\n", undefined],
    ["missing update", "*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** End Patch\n", undefined],
    [
      "stale context",
      "*** Begin Patch\n*** Update File: a\n@@\n-no\n+new\n*** End Patch\n",
      (fs: FileSystem.FileSystem, root: string) => fs.writeFileString(`${root}/a`, "old"),
    ],
    [
      "ambiguous context",
      "*** Begin Patch\n*** Update File: a\n@@\n same\n-new\n+changed\n*** End Patch\n",
      (fs: FileSystem.FileSystem, root: string) => fs.writeFileString(`${root}/a`, "same\nnew\nsame\nnew"),
    ],
    [
      "insert-only hunk",
      "*** Begin Patch\n*** Update File: a\n@@\n+new\n*** End Patch\n",
      (fs: FileSystem.FileSystem, root: string) => fs.writeFileString(`${root}/a`, "old"),
    ],
    [
      "existing move target",
      "*** Begin Patch\n*** Update File: a\n*** Move to: b\n*** End Patch\n",
      (fs: FileSystem.FileSystem, root: string) =>
        Effect.all([fs.writeFileString(`${root}/a`, "a"), fs.writeFileString(`${root}/b`, "b")]).pipe(Effect.asVoid),
    ],
  ] as const
  for (const [name, patch, setup] of rejected) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* failure(patch, setup)
        expect(error._tag).toBe("ApplyPatchError")
      }),
    )
  }
})
