import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { ChildFanOutHost, Client, Content, Ids, ModelHub, Runtime, ToolRuntime } from "@relayfx/sdk"
import { SQLite } from "@relayfx/sdk/sqlite"
import { layerFromClient } from "../src/relay/execution/relay-execution-client-layer"
import { eventHistoryOption } from "../src/model/routing/relay-model-registry"
import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import { Config, Effect, FileSystem, Layer, Logger, Schedule, Schema, Semaphore, Stdio, Stream } from "effect"
import { ProductAgent } from "@rika/product/product-operation"
import * as Turn from "@rika/product/turn-record"

class FixtureError extends Schema.TaggedErrorClass<FixtureError>()("MultiAgentProcessFixtureError", {
  message: Schema.String,
}) {}

const Task = Schema.Struct({ id: Schema.String, prompt: Schema.String, profile: Schema.optional(ProductAgent.Profile) })
const ParallelInput = Schema.Struct({
  parentTurnId: Schema.String,
  fanOutId: Schema.String,
  workspace: Schema.optional(Schema.String),
  tasks: Schema.Array(Task),
  maxConcurrency: Schema.Finite,
  join: Schema.optional(Schema.Literals(["all", "first-success", "quorum", "best-effort"])),
  quorum: Schema.optional(Schema.Finite),
  createdAt: Schema.Finite,
})
const Message = Schema.Union([
  Schema.Struct({ id: Schema.String, type: Schema.Literal("run"), value: ParallelInput }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("inspect"), value: Schema.String }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("cancel"),
    value: Schema.Struct({ id: Schema.String, at: Schema.Finite, reason: Schema.optional(Schema.String) }),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("project"), value: Schema.String }),
])
const ChildResult = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  output: Schema.Array(Schema.TaggedStruct("text", { text: Schema.String })),
  error: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.Finite),
})

const executionRoute: ExecutionRoutePin = Turn.testExecutionRoute()
const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(Message))
const decodeChildResult = Schema.decodeEffect(Schema.UnknownFromJsonString)
const encodeLine = Schema.encodeEffect(Schema.UnknownFromJsonString)
const fixtureError = (error: unknown) => FixtureError.make({ message: String(error) })
const main = Effect.gen(function* () {
  const database = yield* Config.string("RIKA_MULTI_AGENT_DATABASE").pipe(Config.withDefault("missing.sqlite"))
  const control = yield* Config.string("RIKA_MULTI_AGENT_WORKSPACE").pipe(Config.withDefault("."))
  const fileSystem = yield* FileSystem.FileSystem
  const stdio = yield* Stdio.Stdio
  const stdoutLock = yield* Semaphore.make(1)
  const send = Effect.fn("MultiAgentProcess.send")(function* (value: unknown) {
    const encoded = yield* encodeLine(value).pipe(Effect.mapError(fixtureError))
    yield* stdoutLock.withPermit(Stream.run(Stream.make(`${encoded}\n`), stdio.stdout({ endOnDone: false })))
  })
  const append = Effect.fn("MultiAgentProcess.append")(function* (value: unknown) {
    const encoded = yield* encodeLine(value).pipe(Effect.mapError(fixtureError))
    yield* fileSystem.writeFileString(`${control}/visible.ndjson`, `${encoded}\n`, { flag: "a" })
  })
  const handlers = ChildFanOutHost.layer({
    execute: (child, fanOut, idempotencyKey) =>
      Effect.gen(function* () {
        yield* append({
          type: "dispatch",
          fanOutId: fanOut.fan_out_id,
          childId: child.child_execution_id,
          idempotencyKey,
        })
        const release = `${control}/${child.child_execution_id}.json`
        yield* Effect.repeat(fileSystem.exists(release), {
          schedule: Schedule.spaced("10 millis"),
          until: (exists) => exists,
        })
        const encodedResult = yield* fileSystem.readFileString(release).pipe(Effect.mapError(fixtureError))
        const decoded = yield* decodeChildResult(encodedResult).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ChildResult)),
          Effect.mapError(fixtureError),
        )
        yield* append({
          type: "effect",
          fanOutId: fanOut.fan_out_id,
          childId: child.child_execution_id,
          idempotencyKey,
        })
        return {
          status: decoded.status,
          output: decoded.output.map((part) => ({ type: part._tag, text: part.text })),
          ...(decoded.error === undefined ? {} : { error: decoded.error }),
          ...(decoded.completedAt === undefined ? {} : { completed_at: decoded.completedAt }),
        }
      }).pipe(Effect.mapError((error) => ChildFanOutHost.HandlerError.make({ message: String(error) }))),
    cancel: (childId, reason) =>
      append({ type: "cancel", childId, reason }).pipe(
        Effect.mapError((error) => ChildFanOutHost.HandlerError.make({ message: String(error) })),
      ),
  })
  const fixture = yield* TestModel.make(
    Array.from({ length: 20 }, () => TestModel.text("fixture parent")),
    {
      provider: "test",
      model: "deterministic",
      registrationKey: "test",
    },
  )
  const relayLayer = Runtime.layerEmbedded({
    database: SQLite.database({ filename: database, ...eventHistoryOption(database) }),
    languageModelLayer: ModelHub.layer([fixture.registration]),
    toolRuntimeLayer: ToolRuntime.layer(),
    childFanOutHostLayer: handlers,
  })
  const backendLayer = layerFromClient({
    selection: { provider: "test", model: "deterministic" },
  }).pipe(Layer.provide(relayLayer))
  const services = yield* Layer.build(
    Layer.merge(ProductAgent.layer.pipe(Layer.provide(backendLayer)), relayLayer),
  ).pipe(Effect.mapError(fixtureError))
  const handle = Effect.fn("MultiAgentProcess.handle")(function* (message: typeof Message.Type) {
    const value = yield* Effect.gen(function* () {
      const agent = yield* ProductAgent.Service
      if (message.type === "run") {
        const client = yield* Client.Service
        const parentExecutionId = Ids.ExecutionId.make(`execution:${message.value.parentTurnId}`)
        const parent = yield* client.executions.get(parentExecutionId)
        if (parent === undefined) {
          const parentAgentId = Ids.AgentId.make(`agent:fixture:${message.value.parentTurnId}`)
          const address = Ids.AddressId.make("address:rika")
          const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(executionRoute)
          const registered = yield* client.agents.register({
            id: parentAgentId,
            address,
            name: `fixture-${message.value.parentTurnId}`,
            model: {
              provider: fixture.selection.provider,
              model: fixture.selection.model,
              ...(fixture.selection.registrationKey === undefined
                ? {}
                : { registration_key: fixture.selection.registrationKey }),
            },
            permissions: [],
            metadata: { rika_execution_route: durableRoute },
          })
          yield* client.executions.startByAgentDefinition({
            root_address_id: address,
            session_id: Ids.SessionId.make(`session:fixture:${message.value.parentTurnId}`),
            agent_id: parentAgentId,
            agent_revision: registered.record.current_revision,
            input: [Content.text("fixture parent")],
            idempotency_key: `fixture:${message.value.parentTurnId}`,
            execution_id: parentExecutionId,
            started_at: message.value.createdAt,
            completed_at: message.value.createdAt,
          })
        }
        return yield* agent.runParallel({
          parentTurnId: message.value.parentTurnId,
          fanOutId: message.value.fanOutId,
          executionRoute,
          ...(message.value.workspace === undefined ? {} : { workspace: message.value.workspace }),
          tasks: message.value.tasks.map((task) => ({
            id: task.id,
            prompt: task.prompt,
            ...(task.profile === undefined ? {} : { profile: task.profile }),
          })),
          maxConcurrency: message.value.maxConcurrency,
          ...(message.value.join === undefined ? {} : { join: message.value.join }),
          ...(message.value.quorum === undefined ? {} : { quorum: message.value.quorum }),
          createdAt: message.value.createdAt,
        })
      }
      if (message.type === "inspect") return yield* agent.inspectFanOut(message.value)
      if (message.type === "cancel")
        return yield* agent.cancelFanOut(message.value.id, message.value.at, message.value.reason)
      const inspection = yield* agent.inspectFanOut(message.value)
      return inspection === undefined ? [] : agent.projectChildren(inspection)
    }).pipe(Effect.provide(services), Effect.mapError(fixtureError))
    yield* send({ id: message.id, ok: true, value })
  })
  const processLine = Effect.fn("MultiAgentProcess.processLine")(function* (line: string) {
    const message = yield* decodeMessage(line).pipe(Effect.mapError(fixtureError))
    yield* handle(message).pipe(Effect.catch((error) => send({ id: message.id, ok: false, error: error.message })))
  })
  yield* send({ type: "ready", pid: globalThis.process.pid, host: "public" })
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
