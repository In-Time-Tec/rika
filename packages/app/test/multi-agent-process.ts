import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { ProductAgent } from "../src/index"
import { Client, SQLite } from "@relayfx/sdk/sqlite"
import * as RelaySqlite from "@relayfx/sdk/sqlite"

const legacyRuntimes = RelaySqlite as typeof RelaySqlite & { readonly ChildFanOutRuntime?: any }
const legacySqlite = SQLite as typeof SQLite & { readonly childFanOutLayer?: any }
if (legacyRuntimes.ChildFanOutRuntime === undefined || legacySqlite.childFanOutLayer === undefined) {
  process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid, fanOutSurface: false })}\n`)
  process.exit(0)
}
const ChildFanOutRuntime = legacyRuntimes.ChildFanOutRuntime
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import * as RelayExecutionBackend from "@rika/runtime/relay"

const database = process.env.RIKA_MULTI_AGENT_DATABASE ?? "missing.sqlite"
const control = process.env.RIKA_MULTI_AGENT_WORKSPACE ?? "."
const append = (value: unknown) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.writeFileString(`${control}/visible.ndjson`, `${JSON.stringify(value)}\n`, { flag: "a" })
  }).pipe(Effect.provide(fileSystemLayer))
const handlers = ChildFanOutRuntime.testHandlersLayer({
  execute: (child: any, fanOut: any, idempotencyKey: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* append({
        type: "dispatch",
        fanOutId: fanOut.fan_out_id,
        childId: child.child_execution_id,
        idempotencyKey,
      })
      const release = `${control}/${child.child_execution_id}.json`
      while (!(yield* fileSystem.exists(release))) yield* Effect.sleep("10 millis")
      const result = JSON.parse(yield* fileSystem.readFileString(release))
      yield* append({ type: "effect", fanOutId: fanOut.fan_out_id, childId: child.child_execution_id, idempotencyKey })
      return result
    }).pipe(Effect.provide(fileSystemLayer)),
  cancel: (childId: any, reason: any) => append({ type: "cancel", childId, reason }),
})
const fanOutLayer = legacySqlite.childFanOutLayer({ filename: database }, handlers)
const clientLayer = Layer.effect(
  Client.Service,
  Effect.gen(function* () {
    const host = yield* ChildFanOutRuntime.Service
    return Client.Service.of({
      createChildFanOut: host.create,
      inspectChildFanOut: (input: { readonly fan_out_id: string }) =>
        host.inspect(input.fan_out_id).pipe(Effect.map((fan_out) => ({ fan_out }))),
      cancelChildFanOut: (input: {
        readonly fan_out_id: string
        readonly cancelled_at: number
        readonly reason?: string
      }) =>
        host
          .cancel(input.fan_out_id, input.cancelled_at, input.reason ?? "cancelled")
          .pipe(Effect.map((fan_out) => ({ fan_out: fan_out! }))),
    } as unknown as Client.Interface)
  }),
).pipe(Layer.provideMerge(fanOutLayer))
const backend = RelayExecutionBackend.layerFromClient({ selection: { provider: "test", model: "deterministic" } }).pipe(
  Layer.provide(clientLayer as Layer.Layer<any>),
)
const runtime = ManagedRuntime.make(ProductAgent.layer.pipe(Layer.provide(backend)))
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const handle = async (message: { readonly id: string; readonly type: string; readonly value?: unknown }) => {
  const value = await runtime.runPromise(
    Effect.gen(function* () {
      const agent = yield* ProductAgent.Service
      if (message.type === "run") return yield* agent.runParallel(message.value as ProductAgent.ParallelInput)
      if (message.type === "inspect") return yield* agent.inspectFanOut(String(message.value))
      if (message.type === "cancel") {
        const input = message.value as { readonly id: string; readonly at: number; readonly reason?: string }
        return yield* agent.cancelFanOut(input.id, input.at, input.reason)
      }
      const inspection = yield* agent.inspectFanOut(String(message.value))
      return inspection === undefined ? [] : agent.projectChildren(inspection)
    }),
  )
  send({ id: message.id, ok: true, value })
}
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const message = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    void handle(message).catch((error) => send({ id: message.id, ok: false, error: String(error) }))
    newline = buffer.indexOf("\n")
  }
})
send({ type: "ready", pid: process.pid, host: "public", fanOutSurface: true })
