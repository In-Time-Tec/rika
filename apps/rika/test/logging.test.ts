import * as BunServices from "@effect/platform-bun/BunServices"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Logging from "../src/logging"

const LogRecord = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.String,
    annotations: Schema.Record(Schema.String, Schema.Unknown),
  }),
)

const decodeRecord = Schema.decodeUnknownEffect(LogRecord)

describe("Logging", () => {
  it.layer(BunServices.layer)((test) => {
    test.effect("writes Effect JSON logs with secure permissions and reports them", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        yield* TestClock.setTime(1_784_023_200_000)
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(
              Logging.layer({
                dataRoot: root,
                role: "client",
                version: "1.2.3",
                pid: 42,
              }),
            ),
            (logging) =>
              Effect.logInfo("process.started").pipe(
                Effect.annotateLogs({ "rika.process.role": "client", "rika.version": "1.2.3" }),
                Effect.provide(logging),
              ),
          ),
        )
        const diagnostics = path.join(root, "diagnostics")
        const filename = path.join(diagnostics, "client-2026-07-14T10-00-00-000Z-42.jsonl")
        assert.strictEqual((yield* fs.stat(diagnostics)).mode & 0o777, 0o700)
        assert.strictEqual((yield* fs.stat(filename)).mode & 0o777, 0o600)
        const record = yield* decodeRecord((yield* fs.readFileString(filename)).trim())
        assert.strictEqual(record.message, "process.started")
        assert.strictEqual(record.annotations["rika.process.role"], "client")
        assert.deepStrictEqual(yield* Logging.status(root), {
          directory: diagnostics,
          files: 1,
          bytes: (yield* fs.stat(filename)).size,
        })
      }),
    )

    test.effect("writes ordered batches after one second", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        const writes = yield* Ref.make(0)
        const observedFileSystem: FileSystem.FileSystem = {
          ...fs,
          open: (filename, options) =>
            fs.open(filename, options).pipe(
              Effect.map((file) => ({
                ...file,
                write: (bytes: Uint8Array) =>
                  Ref.update(writes, (current) => current + 1).pipe(Effect.andThen(file.write(bytes))),
              })),
            ),
        }
        yield* TestClock.setTime(1_784_023_200_000)
        const logging = yield* Layer.build(
          Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 }).pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, observedFileSystem)),
          ),
        )
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("first")
          yield* Effect.logInfo("second")
          yield* TestClock.adjust(Duration.millis(999))
          assert.strictEqual(yield* Ref.get(writes), 0)
          yield* TestClock.adjust(Duration.millis(1))
          assert.strictEqual(yield* Ref.get(writes), 1)
          const filename = path.join(root, "diagnostics", "client-2026-07-14T10-00-00-000Z-42.open.jsonl")
          const records = yield* Effect.forEach((yield* fs.readFileString(filename)).trim().split("\n"), (line) =>
            decodeRecord(line),
          )
          assert.deepStrictEqual(
            records.map((record) => record.message),
            ["first", "second"],
          )
        }).pipe(Effect.provide(logging), Effect.provideService(FileSystem.FileSystem, observedFileSystem))
      }),
    )

    test.effect("exports only logging files into a private directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        const outputRoot = yield* fs.makeTempDirectoryScoped({ prefix: "rika-export-parent-" })
        const diagnostics = yield* Logging.directory(root)
        yield* fs.makeDirectory(diagnostics, { mode: 0o700 })
        yield* fs.writeFileString(path.join(diagnostics, "client.jsonl"), "{}\n", { mode: 0o600 })
        yield* fs.writeFileString(path.join(diagnostics, "resident.token"), "secret", { mode: 0o600 })
        yield* fs.symlink(path.join(diagnostics, "resident.token"), path.join(diagnostics, "leak.jsonl"))
        const output = path.join(outputRoot, "export")
        assert.strictEqual(yield* Logging.exportLogs(root, output), output)
        assert.deepStrictEqual(yield* fs.readDirectory(output), ["client.jsonl"])
        assert.strictEqual((yield* fs.stat(output)).mode & 0o777, 0o700)
      }),
    )

    test.effect("resolves one canonical data root from both database paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-data-root-" })
        const root = path.join(parent, "data")
        const link = path.join(parent, "data-link")
        yield* fs.makeDirectory(root)
        yield* fs.symlink(root, link)
        assert.strictEqual(
          yield* Logging.resolveDataRoot(path.join(link, "rika.db"), path.join(root, "relay.db")),
          yield* fs.realPath(root),
        )
      }),
    )

    test.effect("honors the configured minimum level", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "resident", version: "1", level: "error", pid: 7 })),
            (logging) =>
              Effect.all([Effect.logInfo("hidden"), Effect.logError("visible")]).pipe(Effect.provide(logging)),
          ),
        )
        const diagnostics = yield* Logging.directory(root)
        const [name] = yield* fs.readDirectory(diagnostics)
        const content = yield* fs.readFileString(path.join(diagnostics, name!))
        assert.notInclude(content, "hidden")
        assert.include(content, "visible")
      }),
    )
  })
})
