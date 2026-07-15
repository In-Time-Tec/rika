import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import {
  ChildFanOutRuntime,
  Client,
  LanguageModelService,
  RunnerRuntime,
  SQLite,
  ToolRuntime,
  WorkflowDefinitionRuntime,
} from "@relayfx/sdk/sqlite"
import {
  Cause,
  Config,
  Context,
  Effect,
  FileSystem,
  Function,
  Layer,
  Logger,
  Schema,
  Semaphore,
  Stdio,
  Stream,
} from "effect"
import { Toolkit } from "effect/unstable/ai"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

class FixtureError extends Schema.TaggedErrorClass<FixtureError>()("WorkflowProcessFixtureError", {
  message: Schema.String,
}) {}

const Message = Schema.Union([
  Schema.Struct({ id: Schema.String, type: Schema.Literal("recover") }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("register") }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("start"),
    value: Schema.Struct({ name: Schema.String, runId: Schema.String, revision: Schema.Finite }),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("inspect"), value: Schema.String }),
])

const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(Message))
const encodeLine = Schema.encodeEffect(Schema.UnknownFromJsonString)
const fixtureError = (error: unknown) => FixtureError.make({ message: String(error) })
const typedRelayLayer = <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, FixtureError, R> =>
  layer.pipe(
    Layer.catchCause(
      (cause): Layer.Layer<unknown, FixtureError, never> =>
        Layer.unwrap(Effect.fail(fixtureError(Cause.squash(cause)))),
    ),
  )

const main = Effect.gen(function* () {
  const database = yield* Config.string("RIKA_WORKFLOW_DATABASE").pipe(Config.withDefault("missing.sqlite"))
  const control = yield* Config.string("RIKA_WORKFLOW_WORKSPACE").pipe(Config.withDefault("."))
  const fileSystem = yield* FileSystem.FileSystem
  const stdio = yield* Stdio.Stdio
  const stdoutLock = yield* Semaphore.make(1)
  yield* Effect.scoped(Layer.build(Layer.orDie(SQLite.layer({ filename: database }))))
  const send = Effect.fn("WorkflowProcess.send")(function* (value: unknown) {
    const encoded = yield* encodeLine(value).pipe(Effect.mapError(fixtureError))
    yield* stdoutLock.withPermit(Stream.run(Stream.make(`${encoded}\n`), stdio.stdout({ endOnDone: false })))
  })
  const append = Effect.fn("WorkflowProcess.append")(function* (value: unknown) {
    const encoded = yield* encodeLine(value).pipe(Effect.mapError(fixtureError))
    yield* fileSystem.writeFileString(`${control}/workflow-visible.ndjson`, `${encoded}\n`, { flag: "a" })
  })
  const execute = Effect.fn("WorkflowProcess.execute")(function* (childId: string, idempotencyKey: string) {
    yield* append({ type: "dispatch", childId, idempotencyKey })
    const release = `${control}/${childId.replaceAll(":", "-")}.release`
    yield* Effect.repeat(Effect.sleep("10 millis"), { until: () => fileSystem.exists(release) })
    yield* append({ type: "effect", childId, idempotencyKey })
    return [{ type: "text" as const, text: childId }]
  })
  const fanOutHandlers = ChildFanOutRuntime.testHandlersLayer({
    execute: (child, _fanOut, idempotencyKey) =>
      execute(String(child.child_execution_id), idempotencyKey).pipe(
        Effect.map((output) => ({ status: "completed" as const, output })),
      ),
    cancel: () => Effect.void,
  })
  const fanOutContext = yield* Layer.build(
    Function.flow(SQLite.childFanOutLayer, typedRelayLayer)({ filename: database }, fanOutHandlers),
  ).pipe(Effect.provide(Context.empty()), Effect.orDie)
  const fanOutLayer = Layer.succeed(ChildFanOutRuntime.Service, Context.get(fanOutContext, ChildFanOutRuntime.Service))
  const workflowHandlers = Layer.effect(
    WorkflowDefinitionRuntime.HandlerService,
    ChildFanOutRuntime.Service.pipe(
      Effect.map((fanOut) =>
        WorkflowDefinitionRuntime.HandlerService.of({
          child: (executionId, operation, context) =>
            execute(`child:${executionId}:${operation.id}`, context.idempotency_key),
          approval: (_executionId, operation) => Effect.succeed({ approved: true, prompt: operation.prompt }),
          timer: (_executionId, operation) => Effect.sleep(`${operation.duration_ms} millis`),
          branch: () => Effect.succeed(true),
          structuredCompletion: (_schema, value) => Effect.succeed(value ?? null),
          createChildFanOut: (definition) => fanOut.create(definition),
          admitChildFanOut: () => Effect.void,
          inspectChildFanOut: fanOut.inspect,
        }),
      ),
    ),
  ).pipe(Layer.provide(fanOutLayer))
  const workflowContext = yield* Layer.build(
    Function.flow(SQLite.workflowLayer, typedRelayLayer)({ filename: database }, workflowHandlers),
  ).pipe(Effect.provide(Context.empty()), Effect.orDie)
  const workflowLayer = Layer.succeed(
    WorkflowDefinitionRuntime.Service,
    Context.get(workflowContext, WorkflowDefinitionRuntime.Service),
  )
  const fixture = yield* TestModel.make(Array.from({ length: 20 }, () => TestModel.text("unused")))
  const runnerLayer = RunnerRuntime.layerWithServices({
    databaseLayer: SQLite.layer({ filename: database }),
    languageModelLayer: LanguageModelService.layer([fixture.registration]),
    toolRuntimeLayer: ToolRuntime.layerFromToolkit(Toolkit.make()).pipe(Layer.provide(Layer.empty)),
  })
  const relayLayer = workflowLayer.pipe(Layer.provideMerge(fanOutLayer), Layer.provideMerge(runnerLayer))
  const clientLayer = Client.layerFromRuntime.pipe(Layer.provideMerge(relayLayer), Layer.orDie)
  const backendLayer = RelayExecutionBackend.layerFromClient({
    selection: { provider: "test", model: "workflow" },
  }).pipe(Layer.provide(clientLayer))
  const services = yield* Layer.build(Layer.merge(backendLayer, workflowLayer)).pipe(Effect.mapError(fixtureError))
  const handle = Effect.fn("WorkflowProcess.handle")(function* (message: typeof Message.Type) {
    const value = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (message.type === "recover") {
        const workflows = yield* WorkflowDefinitionRuntime.Service
        const recover = Function.flow(workflows.recover, Effect.mapError(fixtureError))
        return yield* recover().pipe(Effect.orDie)
      }
      if (message.type === "register") return yield* backend.registerWorkflows()
      if (message.type === "start")
        return yield* backend.startWorkflow(message.value.name, message.value.runId, message.value.revision)
      return yield* backend.inspectWorkflow(message.value)
    }).pipe(Effect.provide(services), Effect.mapError(fixtureError))
    yield* send({ id: message.id, ok: true, value })
  })
  const processLine = Effect.fn("WorkflowProcess.processLine")(function* (line: string) {
    const message = yield* decodeMessage(line).pipe(Effect.mapError(fixtureError))
    yield* handle(message).pipe(Effect.catch((error) => send({ id: message.id, ok: false, error: error.message })))
  })
  yield* send({ type: "ready", pid: globalThis.process.pid, host: "rika" })
  yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => processLine(line).pipe(Effect.forkScoped)),
  )
}).pipe(Effect.scoped)

BunRuntime.runMain(
  Effect.scoped(
    Layer.build(Layer.merge(BunServices.layer, Logger.layer([]))).pipe(
      Effect.flatMap((services) => main.pipe(Effect.provide(services))),
    ),
  ),
  { disableErrorReporting: true },
)
