import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { ChildFanOutRuntime, Client, Ids, SQLite } from "@relayfx/sdk/sqlite"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { Config, Context, Effect, FileSystem, Layer, Logger, Schedule, Schema, Semaphore, Stdio, Stream } from "effect"
import { ProductAgent } from "../src/index"

class FixtureError extends Schema.TaggedErrorClass<FixtureError>()("MultiAgentProcessFixtureError", {
  message: Schema.String,
}) {}

const Task = Schema.Struct({ id: Schema.String, prompt: Schema.String, profile: Schema.optional(ProductAgent.Profile) })
const ParallelInput = Schema.Struct({
  parentTurnId: Schema.String,
  fanOutId: Schema.String,
  workspace: Schema.optional(Schema.String),
  executionRoute: Schema.optional(Schema.Unknown),
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
const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(Message))
const decodeChildResult = Schema.decodeEffect(Schema.UnknownFromJsonString)
const encodeLine = Schema.encodeEffect(Schema.UnknownFromJsonString)
const fixtureError = (error: unknown) => FixtureError.make({ message: String(error) })
const clientError = (error: unknown) => Client.ClientError.make({ message: String(error) })
const unused = () => Effect.die("unused client method")
const unusedStream = () => Stream.die("unused client method")
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
  const handlers = ChildFanOutRuntime.testHandlersLayer({
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
          ...(decoded.completedAt === undefined ? {} : { completedAt: decoded.completedAt }),
        }
      }),
    cancel: (childId, reason) => append({ type: "cancel", childId, reason }),
  })
  const fanOutContext = yield* Layer.build(SQLite.childFanOutLayer({ filename: database }, handlers)).pipe(
    Effect.provide(Context.empty()),
    Effect.mapError(fixtureError),
    Effect.orDie,
  )
  const fanOutLayer = Layer.succeed(ChildFanOutRuntime.Service, Context.get(fanOutContext, ChildFanOutRuntime.Service))
  const clientLayer = Layer.effect(
    Client.Service,
    ChildFanOutRuntime.Service.pipe(
      Effect.map((host) => {
        const implementation: Client.Interface = {
          registerEntityKind: unused,
          getOrCreateEntity: unused,
          getEntity: unused,
          destroyEntity: unused,
          listEntities: unused,
          registerWorkflowDefinition: unused,
          getWorkflowDefinitionRevision: unused,
          listWorkflowDefinitionRevisions: unused,
          startWorkflowRun: unused,
          inspectWorkflowRun: unused,
          replayWorkflowRun: unused,
          cancelWorkflowRun: unused,
          registerAgent: unused,
          registerAgentDefinition: unused,
          getAgentDefinition: unused,
          listAgentDefinitions: unused,
          listAgentDefinitionRevisions: unused,
          getSkillDefinition: unused,
          listSkillDefinitions: unused,
          listSkillDefinitionRevisions: unused,
          registerAddressBookRoute: unused,
          getAddressBookRoute: unused,
          listAddressBookRoutes: unused,
          startExecution: unused,
          startExecutionByAddress: unused,
          startExecutionByAgentDefinition: unused,
          cancelExecution: unused,
          steer: unused,
          getExecution: unused,
          inspectExecution: unused,
          listExecutions: unused,
          listInboxMessages: unused,
          subscribeTopic: unused,
          unsubscribeTopic: unused,
          publishTopic: unused,
          listTopicSubscriptions: unused,
          listSessions: unused,
          getSession: unused,
          listWaits: unused,
          replayExecution: unused,
          pageExecutionEvents: unused,
          listRunners: unused,
          routeExecution: unused,
          send: unused,
          askEntity: unused,
          awaitWait: unused,
          streamExecution: unusedStream,
          followExecution: unusedStream,
          streamSession: unusedStream,
          watchExecutions: unusedStream,
          getEntityState: unused,
          putEntityState: unused,
          deleteEntityState: unused,
          listEntityState: unused,
          getPresence: unused,
          watchPresence: unusedStream,
          wake: unused,
          listPendingApprovals: unused,
          resolveToolApproval: unused,
          resolvePermission: unused,
          listPendingToolCalls: unused,
          fulfillToolCall: unused,
          claimToolWork: unused,
          completeToolWork: unused,
          releaseToolWork: unused,
          listToolAttempts: unused,
          submitInboundEnvelope: unused,
          spawnChildRun: unused,
          createChildFanOut: (input) => host.create(input).pipe(Effect.mapError(clientError)),
          inspectChildFanOut: (input) =>
            host.inspect(Ids.ChildFanOutId.make(input.fan_out_id)).pipe(
              Effect.map((fan_out) => ({ fan_out: fan_out ?? null })),
              Effect.mapError(clientError),
            ),
          cancelChildFanOut: (input) =>
            host.cancel(Ids.ChildFanOutId.make(input.fan_out_id), input.cancelled_at, input.reason ?? "cancelled").pipe(
              Effect.flatMap((fan_out) =>
                fan_out === undefined ? Effect.fail(clientError("fan-out not found")) : Effect.succeed({ fan_out }),
              ),
              Effect.mapError(clientError),
            ),
          claimEnvelopeReady: unused,
          ackEnvelopeReady: unused,
          releaseEnvelopeReady: unused,
          createSchedule: unused,
          cancelSchedule: unused,
          listSchedules: unused,
        }
        return Client.Service.of(implementation)
      }),
    ),
  ).pipe(Layer.provide(fanOutLayer))
  const backendLayer = RelayExecutionBackend.layerFromClient({
    selection: { provider: "test", model: "deterministic" },
  }).pipe(Layer.provide(clientLayer))
  const services = yield* Layer.build(ProductAgent.layer.pipe(Layer.provide(backendLayer))).pipe(
    Effect.mapError(fixtureError),
  )
  const handle = Effect.fn("MultiAgentProcess.handle")(function* (message: typeof Message.Type) {
    const value = yield* Effect.gen(function* () {
      const agent = yield* ProductAgent.Service
      if (message.type === "run") {
        return yield* agent.runParallel({
          parentTurnId: message.value.parentTurnId,
          fanOutId: message.value.fanOutId,
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
