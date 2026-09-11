import * as BunServices from "@effect/platform-bun/BunServices"
import { make as makeSocketServer } from "@effect/platform-node/NodeSocketServer"
import { Context, Effect, FileSystem, Layer, Path, Predicate, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createRequire } from "node:module"

class EngineUnavailable extends Schema.TaggedError<EngineUnavailable>()("RikaTestEngineUnavailable", {
  message: Schema.String,
}) {}

const EngineModule = Schema.Struct({
  getEnginePath: Schema.declare((value): value is () => string => Predicate.isFunction(value)),
})

export const reservePort = Effect.gen(function* () {
  const server = yield* makeSocketServer({ host: "127.0.0.1", port: 0 })
  if (server.address._tag !== "TcpAddress")
    return yield* EngineUnavailable.make({ message: "Expected a local TCP listener" })
  return server.address.port
})

export class RivetEngine extends Context.Service<
  RivetEngine,
  {
    readonly endpoint: string
    readonly engineHost: string
    readonly enginePort: number
    readonly startServices: false
  }
>()("@rika/api/test/fixtures/rivet-engine/RivetEngine") {}

export const rivetEngineLayer = Layer.effect(
  RivetEngine,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rika-rivet-acceptance-" })
    const config = path.join(directory, "rivet.json")
    const [enginePort, peerPort, metricsPort] = yield* Effect.scoped(
      Effect.all([reservePort, reservePort, reservePort]),
    )
    const endpoint = `http://127.0.0.1:${enginePort}`
    yield* fs.writeFileString(
      config,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        topology: {
          datacenter_label: 1,
          datacenters: {
            default: {
              datacenter_label: 1,
              is_leader: true,
              public_url: endpoint,
              peer_url: `http://127.0.0.1:${peerPort}`,
            },
          },
        },
        runtime: {
          worker_load_shedding_curve: [
            [0, 1000],
            [1000, 999],
          ],
        },
      }),
    )
    const engine = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownEffect(EngineModule)(
          createRequire(createRequire(import.meta.url).resolve("rivetkit"))("@rivetkit/engine-cli"),
        ),
      catch: () => EngineUnavailable.make({ message: "The installed Rivet Engine is unavailable" }),
    }).pipe(Effect.flatten)
    const binary = yield* Effect.try({
      try: () => engine.getEnginePath(),
      catch: () => EngineUnavailable.make({ message: "The Rivet Engine binary could not be resolved" }),
    })
    const process = yield* spawner.spawn(
      ChildProcess.make(binary, ["--config", config, "start"], {
        cwd: directory,
        env: {
          RIVET__FILE_SYSTEM__PATH: path.join(directory, "data"),
          RIVET__GUARD__HOST: "127.0.0.1",
          RIVET__GUARD__PORT: String(enginePort),
          RIVET__API_PEER__HOST: "127.0.0.1",
          RIVET__API_PEER__PORT: String(peerPort),
          RIVET__METRICS__HOST: "127.0.0.1",
          RIVET__METRICS__PORT: String(metricsPort),
          RIVET__TELEMETRY__ENABLED: "false",
          RIVET__FEATURES__GUARD_GATEWAY_V3__MODE: "on",
          RIVET__FEATURES__GUARD_GATEWAY_V3__PERCENTAGE: "100",
          RIVET__PEGBOARD__BASE_RETRY_TIMEOUT: "100",
          RIVET__PEGBOARD__ENVOY_ELIGIBLE_THRESHOLD: "5000",
          RIVET__PEGBOARD__ENVOY_LOST_THRESHOLD: "7000",
          RIVET__PEGBOARD__MIN_METADATA_POLL_INTERVAL: "1000",
          RIVET__PEGBOARD__RESCHEDULE_BACKOFF_MAX_EXPONENT: "1",
          RIVET__PEGBOARD__RETRY_RESET_DURATION: "100",
          RIVET__PEGBOARD__RUNNER_ELIGIBLE_THRESHOLD: "5000",
          RIVET__PEGBOARD__RUNNER_LOST_THRESHOLD: "7000",
          RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: "2",
          RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: "1",
          RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: "1",
        },
        stdout: "inherit",
        stderr: "inherit",
        forceKillAfter: "5 seconds",
      }),
    )
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    yield* client.get(`${endpoint}/health`).pipe(
      Effect.flatMap((response) => response.text),
      Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
    )
    if (!(yield* process.isRunning))
      return yield* EngineUnavailable.make({ message: "The owned Rivet Engine exited during startup" })
    return RivetEngine.of({ endpoint, engineHost: "127.0.0.1", enginePort, startServices: false })
  }),
).pipe(Layer.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)))
