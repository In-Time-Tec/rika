import * as BunServices from "@effect/platform-bun/BunServices"
import "./file-logging-lifecycle.fixture"
import { createTestRenderer } from "@opentui/core/testing"
import { assert, describe, it } from "@effect/vitest"
import * as HostedObservability from "@rika/product/hosted-observability"
import { Surface } from "@rika/terminal/opentui-surface"
import { initial } from "@rika/terminal/terminal-state"
import * as Diagnostic from "../../src/diagnostics/file-logging-contract"
import { Deferred, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
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
const encodeUnknown = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

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
    test.effect("acquires in memory and starts filesystem persistence explicitly", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-start-" })
        const calls = yield* Ref.make(0)
        const observedFileSystem: FileSystem.FileSystem = {
          ...fs,
          exists: (path) => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(fs.exists(path))),
          makeDirectory: (path, options) =>
            Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(fs.makeDirectory(path, options))),
          open: (path, options) => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(fs.open(path, options))),
          readDirectory: (path, options) =>
            Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(fs.readDirectory(path, options))),
        }
        yield* TestClock.setTime(1_784_023_200_000)
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(
              Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 }).pipe(
                Layer.provide(Layer.succeed(FileSystem.FileSystem, observedFileSystem)),
              ),
            ),
            (logging) =>
              Effect.gen(function* () {
                yield* Effect.logInfo("startup.buffered")
                assert.strictEqual(yield* Ref.get(calls), 0)
                yield* Logging.start
                assert.isAbove(yield* Ref.get(calls), 0)
              }).pipe(Effect.provide(logging), Effect.provideService(FileSystem.FileSystem, observedFileSystem)),
          ),
        )
        const { records } = yield* writtenRecords(root)
        assert.deepStrictEqual(
          records.map(({ message }) => message),
          ["startup.buffered"],
        )
      }),
    )

    test.effect("retains every record accepted before persistence starts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-buffered-" })
        yield* TestClock.setTime(1_784_023_200_000)
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.gen(function* () {
                yield* Effect.forEach(
                  Array.from({ length: 1_025 }, (_, index) => index),
                  (index) => Effect.logInfo(`startup.buffered.${index}`),
                  { discard: true },
                )
                yield* Logging.start
              }).pipe(Effect.provide(logging)),
          ),
        )
        const { records } = yield* writtenRecords(root)
        assert.strictEqual(records.length, 1_025)
        assert.strictEqual(records[0]?.message, "startup.buffered.0")
        assert.strictEqual(records.at(-1)?.message, "startup.buffered.1024")
      }),
    )

    test.effect("buffers process start without IDs and records first draw without private values", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-frame-" })
        const privateValues = ["private prompt text", "unsent draft text"]
        const calls = yield* Ref.make(0)
        const observedFileSystem: FileSystem.FileSystem = {
          ...fs,
          exists: (filename) => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(fs.exists(filename))),
          open: (filename, options) =>
            Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(fs.open(filename, options))),
        }
        const setup = yield* Effect.acquireRelease(
          Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
          ({ renderer }) => Effect.sync(() => renderer.destroy()),
        )
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        yield* Effect.addFinalizer(() => Effect.sync(() => surface.destroy()))
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(
              Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 }).pipe(
                Layer.provide(Layer.succeed(FileSystem.FileSystem, observedFileSystem)),
              ),
            ),
            (logging) =>
              Effect.gen(function* () {
                const completed = yield* Deferred.make<void>()
                const context = yield* Effect.context<never>()
                const runFirstDraw = Effect.runSyncWith(context)
                yield* HostedObservability.event("process_start", "success", {})
                surface.onNextFrameCompleted(() =>
                  runFirstDraw(
                    HostedObservability.event("first_draw", "success", {}).pipe(
                      Effect.ensuring(Deferred.succeed(completed, undefined)),
                    ),
                  ),
                )
                surface.update(initial(root))
                assert.strictEqual(yield* Ref.get(calls), 0)
                yield* Effect.tryPromise(() => setup.flush())
                yield* Deferred.await(completed)
                assert.strictEqual(yield* Ref.get(calls), 0)
                yield* Logging.start
                assert.isAbove(yield* Ref.get(calls), 0)
              }).pipe(Effect.provide(logging), Effect.provideService(FileSystem.FileSystem, observedFileSystem)),
          ),
        )
        const { records } = yield* writtenRecords(root)
        assert.deepStrictEqual(
          records.map(({ message }) => message),
          ["hosted.process_start.success", "hosted.first_draw.success"],
        )
        assert.deepStrictEqual(
          records.map(({ annotations }) => annotations),
          [
            { "rika.hosted.stage": "process_start", "rika.hosted.outcome": "success" },
            { "rika.hosted.stage": "first_draw", "rika.hosted.outcome": "success" },
          ],
        )
        const rendered = yield* encodeUnknown(records)
        for (const privateValue of privateValues) assert.notInclude(rendered, privateValue)
      }).pipe(Effect.scoped),
    )

    test.effect("serializes concurrent persistence starts within one layer", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-concurrent-start-" })
        yield* Effect.scoped(
          Effect.flatMap(
            Layer.build(Logging.layer({ dataRoot: root, role: "client", version: "1", pid: 42 })),
            (logging) =>
              Effect.all(
                Array.from({ length: 32 }, () => Logging.start),
                {
                  concurrency: "unbounded",
                  discard: true,
                },
              ).pipe(Effect.andThen(Effect.logInfo("concurrent.started")), Effect.provide(logging)),
          ),
        )
        assert.strictEqual((yield* fs.readDirectory(yield* Logging.directory(root))).length, 1)
        const { records } = yield* writtenRecords(root)
        assert.deepStrictEqual(
          records.map(({ message }) => message),
          ["concurrent.started"],
        )
      }),
    )

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
              Effect.andThen(Logging.start, Effect.logInfo("process.started")).pipe(
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
              Effect.andThen(Logging.start, Effect.logError("usage repository refused an incomplete tree", 14)).pipe(
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
        assert.strictEqual(record.detail, "usage repository refused an incomplete tree\n14")
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
              Effect.andThen(
                Logging.start,
                Effect.all(
                  [
                    ...Diagnostic.modelBackendKinds.map((kind) =>
                      Effect.logInfo("model.backend.configured").pipe(
                        Effect.annotateLogs(Diagnostic.modelBackend(kind)),
                      ),
                    ),
                    taggedFailure("WatchTurnFailure"),
                    Effect.logError("failure.tagged").pipe(
                      Effect.annotateLogs(Diagnostic.failureFrom(new Error("invalid model configuration"))),
                    ),
                  ],
                  { concurrency: 1, discard: true },
                ),
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
        const opaque = "private user text /tmp/secret"
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
              Effect.andThen(Logging.start, Effect.logError("failure.tagged")).pipe(
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
  })
})
