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

    test.effect("records only bounded diagnostic fields", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-private-" })
        const secrets = [
          "prompt-secret-72d8",
          "model-body-secret-13a4",
          "tool-output-secret-99bc",
          "shell-secret-02ef",
          "authorization-secret-5d31",
          "credential-secret-f741",
          "arbitrary-error-secret-38ab",
        ]
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.logError(secrets[0], secrets[1]).pipe(
                Effect.annotateLogs({
                  prompt: secrets[0],
                  "model.body": secrets[1],
                  "tool.output": secrets[2],
                  shell: secrets[3],
                  authorization: secrets[4],
                  credential: secrets[5],
                  error: secrets[6],
                  "rika.failure.kind": "InvalidInput",
                }),
                Effect.provide(logging),
              ),
          ),
        )
        const diagnostics = yield* Logging.directory(root)
        const [name] = yield* fs.readDirectory(diagnostics)
        const content = yield* fs.readFileString(path.join(diagnostics, name!))
        for (const secret of secrets) assert.notInclude(content, secret)
        const record = yield* decodeRecord(content.trim())
        assert.strictEqual(record.message, "diagnostic.unstructured")
        assert.deepStrictEqual(record.annotations, { "rika.failure.kind": "InvalidInput" })
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
          yield* Effect.logInfo("test.first")
          yield* Effect.logInfo("test.second")
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
            ["test.first", "test.second"],
          )
        }).pipe(Effect.provide(logging), Effect.provideService(FileSystem.FileSystem, observedFileSystem))
      }),
    )

    test.effect("settles the active filename before a native process boundary", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        yield* TestClock.setTime(1_784_023_200_000)
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 }))
            Logging.settleActiveLogs()
            const names = yield* fs.readDirectory(yield* Logging.directory(root))
            assert.deepStrictEqual(
              names.filter((name) => name.endsWith(".open.jsonl")),
              [],
            )
            assert.strictEqual(names.filter((name) => name.endsWith(".jsonl")).length, 1)
          }),
        )
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
        yield* fs.writeFileString(path.join(diagnostics, "crash.open.jsonl"), '{"truncated":', { mode: 0o600 })
        yield* fs.writeFileString(path.join(diagnostics, "public.jsonl"), "secret", { mode: 0o644 })
        yield* fs.writeFileString(path.join(diagnostics, "resident.token"), "secret", { mode: 0o600 })
        yield* fs.symlink(path.join(diagnostics, "resident.token"), path.join(diagnostics, "leak.jsonl"))
        const output = path.join(outputRoot, "export")
        assert.strictEqual(yield* Logging.exportLogs(root, output), output)
        assert.deepStrictEqual((yield* fs.readDirectory(output)).toSorted(), ["client.jsonl", "crash.open.jsonl"])
        assert.strictEqual((yield* fs.stat(output)).mode & 0o777, 0o700)
        assert.strictEqual((yield* fs.stat(path.join(output, "client.jsonl"))).mode & 0o777, 0o600)
        assert.strictEqual((yield* fs.stat(path.join(output, "crash.open.jsonl"))).mode & 0o777, 0o600)
        assert.deepStrictEqual(yield* Logging.status(root), {
          directory: diagnostics,
          files: 2,
          bytes:
            (yield* fs.stat(path.join(diagnostics, "client.jsonl"))).size +
            (yield* fs.stat(path.join(diagnostics, "crash.open.jsonl"))).size,
        })
      }),
    )

    test.effect("rotates expired closed logs without deleting open crash evidence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-retention-" })
        const diagnostics = yield* Logging.directory(root)
        yield* fs.makeDirectory(diagnostics, { mode: 0o700 })
        const expired = path.join(diagnostics, "client-expired.jsonl")
        const crash = path.join(diagnostics, "resident-expired.open.jsonl")
        yield* fs.writeFileString(expired, "{}\n", { mode: 0o600 })
        yield* fs.writeFileString(crash, '{"partial":', { mode: 0o600 })
        yield* fs.utimes(expired, 0, 0)
        yield* fs.utimes(crash, 0, 0)
        yield* TestClock.setTime(1_784_023_200_000)
        yield* Effect.scoped(Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })))
        assert.isFalse(yield* fs.exists(expired))
        assert.isTrue(yield* fs.exists(crash))
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
              Effect.all([Effect.logInfo("level.hidden"), Effect.logError("level.visible")]).pipe(
                Effect.provide(logging),
              ),
          ),
        )
        const diagnostics = yield* Logging.directory(root)
        const [name] = yield* fs.readDirectory(diagnostics)
        const content = yield* fs.readFileString(path.join(diagnostics, name!))
        assert.notInclude(content, "level.hidden")
        assert.include(content, "level.visible")
      }),
    )
  })
})
