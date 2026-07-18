import { expect, test } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import { assertAndRemoveExpectedOpenLogs, findResidueFiles } from "./lease-files"
import { runTest } from "./process"

test("stress residue finds startup files and stale open logs without treating live logs or dead patterns as leaks", () =>
  runTest(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectory({ prefix: "rika-residue-" })
      yield* Effect.addFinalizer(() => fileSystem.remove(home, { recursive: true }).pipe(Effect.ignore))
      const diagnostics = path.join(home, ".rika", "diagnostics")
      yield* fileSystem.makeDirectory(diagnostics, { recursive: true })
      const stalePid = 2_147_483_647
      const startup = path.join(home, ".rika", "resident-default.startup")
      const startupTemporary = path.join(home, ".rika", "resident-default.startup.nonce.tmp")
      const staleOpen = path.join(diagnostics, `client-2026-07-16T00-00-00-000Z-${stalePid}.open.jsonl`)
      const liveOpen = path.join(diagnostics, `resident-2026-07-16T00-00-00-000Z-${process.pid}.open.jsonl`)
      yield* Effect.forEach(
        [
          startup,
          startupTemporary,
          staleOpen,
          liveOpen,
          path.join(home, "unused.lease"),
          path.join(home, "unused.lock"),
        ],
        (file) => fileSystem.writeFileString(file, ""),
        { discard: true },
      )

      const residue = yield* findResidueFiles(home)
      expect(residue.map((entry) => entry.path)).toEqual([staleOpen, startup, startupTemporary].toSorted())
      expect(residue.map((entry) => entry.kind).toSorted()).toEqual(["stale-open-log", "startup", "startup"])

      yield* Effect.forEach([startup, startupTemporary], (file) => fileSystem.remove(file), { discard: true })
      const removed = yield* assertAndRemoveExpectedOpenLogs(home, [stalePid])
      expect(removed.map((entry) => entry.pid)).toEqual([stalePid])
      expect(yield* fileSystem.exists(staleOpen)).toBe(false)
      expect(yield* fileSystem.exists(liveOpen)).toBe(true)
    }).pipe(Effect.scoped),
  ))
