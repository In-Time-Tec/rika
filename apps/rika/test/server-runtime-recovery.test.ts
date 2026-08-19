import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer } from "effect"
import {
  archiveIncompatibleRuntime,
  archivedRuntimeName,
  isSchemaChecksumMismatch,
} from "../src/server/composition/server-runtime-recovery"

test("recognises the Baton schema checksum mismatch in every shape it arrives", () => {
  expect(isSchemaChecksumMismatch({ _tag: "tenetkit/runtime/SchemaChecksumMismatch" })).toBe(true)
  expect(
    isSchemaChecksumMismatch({
      message: 'StartTurnFailure: {"_tag":"tenetkit/runtime/SchemaChecksumMismatch","source":"/x/baton.db"}',
    }),
  ).toBe(true)
  expect(isSchemaChecksumMismatch('{"_tag":"tenetkit/runtime/SchemaChecksumMismatch"}')).toBe(true)
  expect(isSchemaChecksumMismatch({ _tag: "tenetkit/runtime/RunNotFound" })).toBe(false)
  expect(isSchemaChecksumMismatch(undefined)).toBe(false)
})

test("archives an incompatible runtime database and its sidecars so the next start rebuilds", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-archive-" })
      const filename = `${directory}/baton.db`
      yield* fileSystem.writeFileString(filename, "stale")
      yield* fileSystem.writeFileString(`${filename}-wal`, "stale-wal")

      const archived = yield* archiveIncompatibleRuntime(filename)

      expect(yield* fileSystem.exists(filename)).toBe(false)
      expect(yield* fileSystem.exists(`${filename}-wal`)).toBe(false)
      expect(yield* fileSystem.readFileString(archived)).toBe("stale")
      expect(yield* fileSystem.readFileString(`${archived}-wal`)).toBe("stale-wal")
      expect(archived.startsWith(`${filename}.incompatible-`)).toBe(true)
    }),
  )
  return Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((services) => Effect.provide(program, services)))),
  )
})

test("names the archive from the runtime path and the observed time", () => {
  expect(archivedRuntimeName("/x/baton.db", 42)).toBe("/x/baton.db.incompatible-42")
})

test("archiving is safe when the sidecars were never created", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-archive-bare-" })
      const filename = `${directory}/baton.db`
      yield* fileSystem.writeFileString(filename, "only-main")
      const archived = yield* archiveIncompatibleRuntime(filename)
      expect(yield* fileSystem.readFileString(archived)).toBe("only-main")
    }),
  )
  return Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((services) => Effect.provide(program, services)))),
  )
})
