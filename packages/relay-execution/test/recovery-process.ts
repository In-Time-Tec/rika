import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import { Config, Context, Effect, Layer, Logger, Schema, Semaphore, Stdio, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as RelayExecutionBackend from "../src/relay/execution/relay-execution-layer"
import { start } from "./current-execution-route"

class FixtureError extends Schema.TaggedErrorClass<FixtureError>()("RecoveryProcessFixtureError", {
  message: Schema.String,
}) {}

const Message = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["start", "logs"]),
  value: Schema.optional(Schema.String),
})
const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(Message))
const encodeLine = Schema.encodeEffect(Schema.UnknownFromJsonString)
const fixtureError = (error: unknown) => FixtureError.make({ message: String(error) })
const promptSecret = "PROMPT_SECRET_SENTINEL_206_207_209"
const initialSystemSecret = "SYSTEM_SECRET_SENTINEL_INITIAL_206_207_209"
const recoveredSystemSecret = "SYSTEM_SECRET_SENTINEL_RECOVERED_206_207_209"
const logs: Array<string> = []
const logger = Logger.make((options) => logs.push(Logger.formatJson.log(options)))

const main = Effect.gen(function* () {
  const database = yield* Config.string("RIKA_RECOVERY_DATABASE")
  const workspace = yield* Config.string("RIKA_RECOVERY_WORKSPACE")
  const phase = yield* Config.string("RIKA_RECOVERY_PHASE")
  const stdio = yield* Stdio.Stdio
  const output = yield* Semaphore.make(1)
  const send = (value: unknown) =>
    encodeLine(value).pipe(
      Effect.mapError(fixtureError),
      Effect.flatMap((line) =>
        output.withPermit(Stream.run(Stream.make(`${line}\n`), stdio.stdout({ endOnDone: false }))),
      ),
    )
  const initial = TestModel.turn([
    TestModel.toolCall("task", { prompt: "alpha" }, { id: "call-alpha" }),
    TestModel.toolCall("task", { prompt: "beta" }, { id: "call-beta" }),
    TestModel.toolCall("task", { prompt: "gamma" }, { id: "call-gamma" }),
    TestModel.toolCall("context_probe", {}, { id: "call-checkpoint-barrier" }),
  ])
  let turns: ReadonlyArray<TestModel.Step> = Array.from({ length: 6 }, (_, index) =>
    TestModel.text(`recovered child ${index}`),
  )
  if (phase === "recovered-delayed")
    turns = [
      TestModel.text("recovered child 0"),
      TestModel.text("recovered child 1"),
      ...Array.from({ length: 4 }, (_, index) =>
        TestModel.turn([TestModel.text(`delayed recovered child ${index + 2}`)], { delay: "5 minutes" }),
      ),
    ]
  if (phase === "recovered-stuck")
    turns = Array.from({ length: 9 }, (_, index) =>
      TestModel.turn([TestModel.text(`stuck recovered child ${index}`)], { delay: "5 minutes" }),
    )
  if (phase === "initial")
    turns = [
      initial,
      TestModel.turn([TestModel.text("alpha outcome")], { delay: "5 minutes" }),
      TestModel.turn([TestModel.text("beta outcome")], { delay: "5 minutes" }),
      TestModel.turn([TestModel.text("gamma outcome")], { delay: "5 minutes" }),
      TestModel.text("root must not continue"),
    ]
  const fixture = yield* TestModel.make(turns)
  const systemSecret = phase === "initial" ? initialSystemSecret : recoveredSystemSecret
  const contextProbe = Tool.make("context_probe", {
    description: `Recovery context probe ${systemSecret}`,
    parameters: Schema.Struct({}),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  })
  const contextToolkit = Toolkit.make(contextProbe)
  const backendLayer = RelayExecutionBackend.layer({
    filename: database,
    workspace,
    registration: fixture.registration,
    selection: fixture.selection,
    modelVariantPolicy: "fixed-selection",
    toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
    additionalToolkit: contextToolkit,
    additionalHandlerLayer: contextToolkit.toLayer({
      context_probe: () =>
        phase === "initial" ? Effect.sleep("5 minutes").pipe(Effect.as("unused")) : Effect.succeed("unused"),
    }),
    recoveryChildSettlementGrace: phase === "recovered-stuck" ? "0 millis" : "5 minutes",
  })
  const services = yield* Layer.build(backendLayer).pipe(Effect.mapError(fixtureError))
  const backend = Context.get(services, ExecutionBackend.Service)
  yield* send({ type: "ready", pid: globalThis.process.pid })
  yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      decodeMessage(line).pipe(
        Effect.mapError(fixtureError),
        Effect.flatMap((message) =>
          message.type === "logs"
            ? send({ id: message.id, ok: true, value: logs })
            : start(backend, {
                threadId: "thread-recovery",
                turnId: message.value ?? "turn-recovery",
                prompt: promptSecret,
              }).pipe(
                Effect.flatMap((result) => send({ id: message.id, ok: true, value: result.status })),
                Effect.catch((error) => send({ id: message.id, ok: false, error: String(error) })),
              ),
        ),
        Effect.forkScoped,
      ),
    ),
  )
}).pipe(Effect.scoped)

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.merge(BunServices.layer, Logger.layer([logger])))
      return yield* Effect.provide(main, context)
    }),
  ),
  { disableErrorReporting: true },
)
