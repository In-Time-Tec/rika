import { assert, describe, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Duration, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Logging from "../../src/diagnostics/file-logging"

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
    test.effect("omits arbitrary message values, objects, and failure causes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-private-values-" })
        const secret = "cause-secret-f839"
        class CyclicValue {
          readonly value: string
          self?: CyclicValue
          constructor(value: string) {
            this.value = value
          }
        }
        const cyclic = new CyclicValue(secret)
        cyclic.self = cyclic
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.andThen(
                Logging.start,
                Effect.all([
                  Effect.logWarning("usage repository refused an incomplete tree", cyclic),
                  Effect.logInfo("execution.follow.started", cyclic),
                  Effect.logWarning("usage-cost.read.failed", Cause.fail(secret)),
                ]),
              ).pipe(Effect.provide(logging)),
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

    test.effect("persists only validated hosted continuity annotations", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-hosted-" })
        const sensitive = "SENSITIVE-PROMPT-/home/alice/private/project"
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "server", version: "1", pid: 42 })),
            (logging) =>
              Effect.andThen(Logging.start, Effect.logInfo("hosted.tool_execution.success")).pipe(
                Effect.annotateLogs({
                  "rika.hosted.stage": "tool_execution",
                  "rika.hosted.outcome": "success",
                  "rika.duration.millis": 321,
                  "rika.thread.id": "thread-01",
                  "rika.turn.id": "turn:02",
                  "rika.run.id": "run-03",
                  "rika.operation.id": "operation.04",
                  "rika.tool_call.id": "tool-call-05",
                  "rika.model_attempt.id": "attempt:07",
                  "rika.failure.message": sensitive,
                  owner: sensitive,
                  command: sensitive,
                  assignment: sensitive,
                  sandbox: sensitive,
                  build: sensitive,
                  checkpoint: sensitive,
                  prompt: sensitive,
                  payload: sensitive,
                  path: sensitive,
                  secret: sensitive,
                }),
                Effect.provide(logging),
              ),
          ),
        )
        const { content, records } = yield* writtenRecords(root)
        assert.notInclude(content, sensitive)
        assert.deepStrictEqual(records[0]?.annotations, {
          "rika.hosted.stage": "tool_execution",
          "rika.hosted.outcome": "success",
          "rika.duration.millis": 321,
          "rika.thread.id": "thread-01",
          "rika.turn.id": "turn:02",
          "rika.run.id": "run-03",
          "rika.operation.id": "operation.04",
          "rika.tool_call.id": "tool-call-05",
          "rika.model_attempt.id": "attempt:07",
        })
      }),
    )

    test.effect("rejects invalid hosted annotations and user text", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-hosted-invalid-" })
        const sentinel = "SENSITIVE user payload /var/lib/rika/secrets.db"
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "server", version: "1", pid: 42 })),
            (logging) =>
              Effect.andThen(Logging.start, Effect.logInfo("hosted.terminal.failure")).pipe(
                Effect.annotateLogs({
                  "rika.hosted.stage": sentinel,
                  "rika.hosted.outcome": "maybe",
                  "rika.duration.millis": -1,
                  "rika.thread.id": sentinel,
                  "rika.turn.id": "turn id with spaces",
                  "rika.run.id": "run/with/path",
                  "rika.operation.id": "x".repeat(129),
                  "rika.tool_call.id": "not a valid call id",
                  "rika.model_attempt.id": { prompt: sentinel },
                }),
                Effect.provide(logging),
              ),
          ),
        )
        const { content, records } = yield* writtenRecords(root)
        assert.notInclude(content, sentinel)
        assert.deepStrictEqual(records[0]?.annotations, {})
      }),
    )

    test.effect("records closed failure fields without arbitrary failure text", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-annotations-" })
        const privateFailureText = [
          "Cause.pretty: prompt=Delete every file under /home/alice/private-workspace",
          "error.message: failed path /var/lib/rika/secrets.db at postgresql://admin:db-password@db.internal/rika",
          'raw upstream: Bearer sk-live-7f3a9c2d SQL=SELECT * FROM credentials input={"token":"ghp_0123456789abcdef"}',
        ]
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.andThen(
                Logging.start,
                Effect.forEach(
                  privateFailureText,
                  (message) =>
                    Effect.logInfo("execution.follow.started").pipe(
                      Effect.annotateLogs({
                        "rika.failure.cause": "TranscriptRepositoryError",
                        "rika.failure.category": "dependency_unavailable",
                        "rika.failure.interrupted": false,
                        "rika.failure.kind": "WatchTurnFailure",
                        "rika.failure.message": message,
                        "rika.failure.outcome": "known",
                        "rika.follow.cursor": "cursor-42",
                        "rika.follow.reason": "thread-open",
                        "rika.follow.scope": "tree",
                        "rika.http.status": 429,
                        "rika.reconnect.attempt": 3,
                        "rika.reconnect.delay.ms": 42_000,
                        "rika.reconnect.message": "execution stream closed",
                        "rika.retry_after.ms": 42_000,
                        "rika.unknown.annotation": "dropped-annotation-a41c",
                      }),
                    ),
                  { concurrency: 1, discard: true },
                ),
              ).pipe(Effect.provide(logging)),
          ),
        )
        const { content, records } = yield* writtenRecords(root)
        for (const privateText of privateFailureText) assert.notInclude(content, privateText)
        for (const record of records) {
          assert.deepStrictEqual(record.annotations, {
            "rika.failure.category": "dependency_unavailable",
            "rika.failure.interrupted": false,
            "rika.failure.kind": "WatchTurnFailure",
            "rika.failure.outcome": "known",
            "rika.follow.cursor": "cursor-42",
            "rika.follow.reason": "thread-open",
            "rika.follow.scope": "tree",
            "rika.http.status": 429,
            "rika.reconnect.attempt": 3,
            "rika.reconnect.delay.ms": 42_000,
            "rika.retry_after.ms": 42_000,
          })
        }
        assert.notInclude(content, "dropped-annotation-a41c")
      }),
    )

    test.effect("writes ordered batches after one second", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        yield* TestClock.setTime(1_784_023_200_000)
        const logging = yield* Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 }))
        yield* Effect.gen(function* () {
          yield* Logging.start
          yield* Effect.logInfo("test.first")
          yield* Effect.logInfo("test.second")
          yield* TestClock.adjust(Duration.millis(999))
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
          assert.deepStrictEqual(
            records.map((record) => record.message),
            ["test.first", "test.second"],
          )
        }).pipe(Effect.provide(logging))
      }),
    )

    test.effect("writes final buffered records before closing and renaming", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-settlement-race-" })
        yield* TestClock.setTime(1_784_023_200_000)
        const logging = yield* Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 }))
        yield* Effect.gen(function* () {
          yield* Logging.start
          yield* Effect.logInfo("race.inflight")
          yield* TestClock.adjust(Duration.seconds(1))
          yield* Effect.logInfo("race.final")
          yield* Logging.settleActiveLogs
          yield* Effect.logInfo("race.rejected")
        }).pipe(Effect.provide(logging))
        const { records } = yield* writtenRecords(root)
        assert.deepStrictEqual(
          records.map(({ message }) => message),
          ["race.inflight", "race.final"],
        )
      }),
    )

    test.effect("settles the active filename before a native process boundary", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        yield* TestClock.setTime(1_784_023_200_000)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const logging = yield* Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 }))
            yield* Logging.start.pipe(Effect.provide(logging))
            yield* Logging.settleActiveLogs
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
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) => Logging.start.pipe(Effect.provide(logging)),
          ),
        )
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
              Effect.andThen(
                Logging.start,
                Effect.all([Effect.logInfo("level.hidden"), Effect.logError("level.visible")]),
              ).pipe(Effect.provide(logging)),
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
