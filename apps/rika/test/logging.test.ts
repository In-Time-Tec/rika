import * as BunServices from "@effect/platform-bun/BunServices"
import { assert, describe, it } from "@effect/vitest"
import * as Diagnostic from "../src/diagnostics/diagnostic-file-logging-contract"
import { Cause, Duration, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Logging from "../src/diagnostics/diagnostic-file-logging"

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
          "sk-live-72d8a41f",
          "pk-live-13a4b72e",
          "opaque-99bcf105",
          "private-02efab84",
          "bearer-5d31c990",
          "key-f7412dde",
          "failure-38ab6c21",
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
                  "rika.execution.id": "run-42",
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
          "rika.execution.id": "run-42",
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

    test.effect("preserves shared typed producer diagnostics through the logger", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-producer-contract-" })
        const taggedFailure = (kind: Diagnostic.FailureKind) =>
          Effect.logError("failure.tagged").pipe(Effect.annotateLogs(Diagnostic.failure(kind)))
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "server", version: "1", pid: 42 })),
            (logging) =>
              Effect.all(
                [
                  ...Diagnostic.modelBackendKinds.map((kind) =>
                    Effect.logInfo("model.backend.configured").pipe(Effect.annotateLogs(Diagnostic.modelBackend(kind))),
                  ),
                  taggedFailure("WatchTurnFailure"),
                  Effect.logError("failure.tagged").pipe(
                    Effect.annotateLogs(Diagnostic.failureFrom(new Error("invalid model configuration"))),
                  ),
                ],
                { concurrency: 1, discard: true },
              ).pipe(Effect.provide(logging)),
          ),
        )
        const { records } = yield* writtenRecords(root)
        assert.deepStrictEqual(
          records.map((record) => record.annotations),
          [
            { "rika.model.backend.kind": "provider" },
            { "rika.model.backend.kind": "test-script" },
            { "rika.model.backend.kind": "test-response" },
            { "rika.failure.kind": "WatchTurnFailure" },
            { "rika.failure.kind": "Error" },
          ],
        )
      }),
    )

    test.effect("rejects opaque values from every approved string field while retaining known tags", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-string-schemas-" })
        const opaque = "sk-live-7f3a9c2d"
        const stringFields = [
          "rika.event.cursor",
          "rika.event.type",
          "rika.execution.id",
          "rika.failure.category",
          "rika.failure.kind",
          "rika.failure.outcome",
          "rika.follow.cursor",
          "rika.follow.reason",
          "rika.follow.scope",
          "rika.model.selection",
          "rika.model.backend.kind",
          "rika.model.name",
          "rika.model.provider",
          "rika.model.registration_key",
          "rika.operation",
          "rika.process.instance",
          "rika.process.role",
          "rika.reconciliation.cursor.initial",
          "rika.reconciliation.cursor.replayed",
          "rika.server.client.kind",
          "rika.server.command.tag",
          "rika.server.connection.id",
          "rika.server.connection.role",
          "rika.server.rejection.reason",
          "rika.server.request.id",
          "rika.server.session.id",
          "rika.server.shutdown.reason",
          "rika.server.startup.role",
          "rika.thread.id",
          "rika.tool.call.id",
          "rika.tool.dependency",
          "rika.tool.name",
          "rika.turn.id",
          "rika.version",
        ]
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.logError("failure.tagged").pipe(
                Effect.annotateLogs({
                  ...Object.fromEntries(stringFields.map((key) => [key, opaque])),
                  "rika.failure.kind": "TokenExpiredError",
                }),
                Effect.provide(logging),
              ),
          ),
        )
        const { content, records } = yield* writtenRecords(root)
        assert.notInclude(content, opaque)
        assert.deepStrictEqual(records[0]?.annotations, { "rika.failure.kind": "TokenExpiredError" })
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
                  "rika.failure.cause": "TranscriptRepositoryError",
                  "rika.failure.kind": "WatchTurnFailure",
                  "rika.failure.message": "ExecutionNotFound",
                  "rika.follow.cursor": "cursor-42",
                  "rika.follow.reason": "thread-open",
                  "rika.follow.scope": "tree",
                  "rika.reconnect.attempt": 3,
                  "rika.reconnect.message": "execution stream closed",
                  "rika.unknown.annotation": "dropped-annotation-a41c",
                }),
                Effect.provide(logging),
              ),
          ),
        )
        const { content, records } = yield* writtenRecords(root)
        assert.deepStrictEqual(records[0]?.annotations, {
          "rika.failure.kind": "WatchTurnFailure",
          "rika.failure.message": "ExecutionNotFound",
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
        yield* fs.writeFileString(path.join(diagnostics, "server.token"), "secret", { mode: 0o600 })
        yield* fs.symlink(path.join(diagnostics, "server.token"), path.join(diagnostics, "leak.jsonl"))
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
        const crash = path.join(diagnostics, "server-expired.open.jsonl")
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
            Layer.build(Logging.layer({ dataRoot: root, role: "server", version: "1", level: "error", pid: 7 })),
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
