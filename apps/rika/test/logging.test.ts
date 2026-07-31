import * as BunServices from "@effect/platform-bun/BunServices"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Duration, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Logging from "../src/logging"

const LogRecord = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.String,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.String),
    annotations: Schema.Record(Schema.String, Schema.Unknown),
  }),
)

const decodeRecord = Schema.decodeUnknownEffect(LogRecord)

const writtenRecords = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const diagnostics = yield* Logging.directory(root)
    const [name] = yield* fs.readDirectory(diagnostics)
    const content = (yield* fs.readFileString(path.join(diagnostics, name!))).trim()
    return { content, records: yield* Effect.forEach(content.split("\n"), (line) => decodeRecord(line)) }
  })

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
              Effect.logError("usage repository refused an incomplete tree", 14).pipe(
                Effect.annotateLogs({
                  prompt: secrets[0],
                  "model.body": secrets[1],
                  "tool.output": secrets[2],
                  shell: secrets[3],
                  authorization: secrets[4],
                  credential: secrets[5],
                  error: secrets[6],
                  "rika.execution.id": "execution-42",
                  "rika.failure.category": "invalid_input",
                  "rika.failure.interrupted": false,
                  "rika.failure.kind": secrets[6],
                  "rika.failure.outcome": "known",
                  "rika.tool.call.id": "call-7",
                  "rika.tool.deadline.ms": 10_000,
                  "rika.tool.dependency": "parallel",
                  "rika.tool.retry.attempt": 2,
                  "rika.tool.retry.delay.ms": 200,
                  "rika.duration.ms": 9_876,
                  "rika.tool.name": "read",
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
        assert.strictEqual(record.detail, undefined)
        assert.deepStrictEqual(record.annotations, {
          "rika.execution.id": "execution-42",
          "rika.failure.category": "invalid_input",
          "rika.failure.interrupted": false,
          "rika.failure.outcome": "known",
          "rika.tool.call.id": "call-7",
          "rika.tool.deadline.ms": 10_000,
          "rika.tool.dependency": "parallel",
          "rika.tool.retry.attempt": 2,
          "rika.tool.retry.delay.ms": 200,
          "rika.duration.ms": 9_876,
          "rika.tool.name": "read",
        })
      }),
    )

    test.effect("omits arbitrary message values, objects, and failure causes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-private-values-" })
        const secret = "cause-secret-f839"
        const cyclic: Record<string, unknown> = { value: secret }
        cyclic.self = cyclic
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.all([
                Effect.logWarning("usage repository refused an incomplete tree", cyclic),
                Effect.logInfo("execution.follow.started", cyclic),
                Effect.logWarning("usage-cost.read.failed", Cause.fail(secret)),
              ]).pipe(Effect.provide(logging)),
          ),
        )
        const { content, records } = yield* writtenRecords(root)
        assert.notInclude(content, secret)
        assert.notInclude(content, "[object Object]")
        assert.deepStrictEqual(
          records.map((record) => record.message),
          ["diagnostic.unstructured", "execution.follow.started", "diagnostic.unstructured"],
        )
        for (const record of records) {
          assert.strictEqual(record.detail, undefined)
          assert.strictEqual(record.cause, undefined)
        }
      }),
    )

    test.effect("records follow and reconnect annotations without unknown keys", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-annotations-" })
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.logInfo("execution.follow.started").pipe(
                Effect.annotateLogs({
                  "rika.failure.cause": "UsageRepositoryError",
                  "rika.follow.cursor": "cursor-42",
                  "rika.follow.reason": "thread-open",
                  "rika.follow.scope": "tree",
                  "rika.reconnect.attempt": 3,
                  "rika.reconnect.message": "relay stream closed",
                  "rika.unknown.annotation": "dropped-annotation-a41c",
                }),
                Effect.provide(logging),
              ),
          ),
        )
        const { content, records } = yield* writtenRecords(root)
        assert.deepStrictEqual(records[0]?.annotations, {
          "rika.follow.cursor": "cursor-42",
          "rika.follow.reason": "thread-open",
          "rika.follow.scope": "tree",
          "rika.reconnect.attempt": 3,
        })
        assert.notInclude(content, "dropped-annotation-a41c")
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
          const filename = path.join(root, "diagnostics", "client-2026-07-14T10-00-00-000Z-42.open.jsonl")
          const decodeBatch = Effect.gen(function* () {
            const content = (yield* fs.readFileString(filename)).trim()
            if (content.length === 0) return undefined
            return yield* Effect.forEach(content.split("\n"), (line) => decodeRecord(line))
          }).pipe(Effect.orElseSucceed(() => undefined))
          let records: ReadonlyArray<{ readonly message: string }> | undefined
          for (let attempt = 0; records === undefined; attempt += 1) {
            const decoded = yield* decodeBatch
            if (decoded !== undefined && decoded.length === 2) records = decoded
            else if (attempt >= 100_000) return yield* Effect.die("log batch did not flush")
            else yield* Effect.yieldNow
          }
          assert.strictEqual(yield* Ref.get(writes), 1)
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
