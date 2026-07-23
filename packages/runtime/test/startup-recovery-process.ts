import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { Config, Effect, Layer, Logger, Schema, Semaphore, Stdio, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

class FixtureError extends Schema.TaggedErrorClass<FixtureError>()("StartupRecoveryFixtureError", {
  message: Schema.String,
}) {}

const Message = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("start"),
    value: Schema.Struct({ threadId: Schema.String, turnId: Schema.String, prompt: Schema.String }),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("inspect"), value: Schema.String }),
])

const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(Message))
const encodeLine = Schema.encodeEffect(Schema.UnknownFromJsonString)
const fixtureError = (cause: unknown) => FixtureError.make({ message: String(cause) })

const initialScript = [
  TestModel.turn([
    TestModel.toolCall("task", { prompt: "Explore alpha." }, { id: "call-alpha" }),
    TestModel.toolCall("task", { prompt: "Explore beta." }, { id: "call-beta" }),
    TestModel.toolCall("task", { prompt: "Explore gamma." }, { id: "call-gamma" }),
    TestModel.toolCall("task", { prompt: "Explore delta." }, { id: "call-delta" }),
  ]),
  ...Array.from({ length: 8 }, () => TestModel.turn([TestModel.text("held")], { delay: "3600 seconds" })),
]

const replacementScript = Array.from({ length: 10 }, () => TestModel.text("recovered output"))

const main = Effect.gen(function* () {
  const database = yield* Config.string("RIKA_RECOVERY_DATABASE").pipe(Config.withDefault("missing.sqlite"))
  const workspace = yield* Config.string("RIKA_RECOVERY_WORKSPACE").pipe(Config.withDefault("."))
  const phase = yield* Config.string("RIKA_RECOVERY_PHASE").pipe(Config.withDefault("initial"))
  const stdio = yield* Stdio.Stdio
  const stdoutLock = yield* Semaphore.make(1)
  const send = Effect.fn("StartupRecoveryProcess.send")(function* (value: unknown) {
    const encoded = yield* encodeLine(value).pipe(Effect.mapError(fixtureError))
    yield* stdoutLock.withPermit(Stream.run(Stream.make(`${encoded}\n`), stdio.stdout({ endOnDone: false })))
  })
  const fixture = yield* TestModel.make(phase === "initial" ? initialScript : replacementScript)
  const registration = yield* ModelRegistry.registration({ ...fixture.selection, layer: fixture.layer })
  const backendLayer = RelayExecutionBackend.layer({
    filename: database,
    workspace,
    registration,
    selection: fixture.selection,
    modelVariantPolicy: "fixed-selection",
    toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
    toolNeedsApproval: () => false,
    permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
  })
  const services = yield* Layer.build(backendLayer).pipe(Effect.mapError(fixtureError))
  const handle = Effect.fn("StartupRecoveryProcess.handle")(function* (message: typeof Message.Type) {
    const value = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (message.type === "start") {
        yield* start(backend, { ...message.value, startedAt: 1 }).pipe(Effect.ignore, Effect.forkScoped)
        return { started: true }
      }
      const inspection = yield* backend.inspect(message.value)
      if (inspection === undefined) return undefined
      return {
        status: inspection.status,
        pendingToolCount: inspection.pendingTools.length,
        children: inspection.children.map((child) => ({
          executionId: String(child.executionId),
          status: child.status,
        })),
      }
    }).pipe(Effect.provide(services), Effect.mapError(fixtureError))
    yield* send({ id: message.id, ok: true, value })
  })
  const processLine = Effect.fn("StartupRecoveryProcess.processLine")(function* (line: string) {
    const message = yield* decodeMessage(line).pipe(Effect.mapError(fixtureError))
    yield* handle(message).pipe(Effect.catch((cause) => send({ id: message.id, ok: false, error: cause.message })))
  })
  yield* send({ type: "ready", pid: globalThis.process.pid, host: "rika" })
  yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => processLine(line).pipe(Effect.forkScoped)),
  )
}).pipe(Effect.scoped)

const program = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.merge(BunServices.layer, Logger.layer([])))
    return yield* Effect.provide(main, context)
  }),
)

BunRuntime.runMain(program, { disableErrorReporting: true })
