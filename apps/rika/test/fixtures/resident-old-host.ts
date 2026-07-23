import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ResidentService from "@rika/app/resident-service"
import { Config, Effect, FileSystem, Layer, Logger, Path, Schema } from "effect"
import { readOrCreateToken, resolve } from "../../src/resident-endpoint"

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_RESIDENT_DATA_ROOT")
  const recordPid = (yield* Config.string("RIKA_TEST_RESIDENT_RECORD_PID").pipe(Config.withDefault("1"))) !== "0"
  const mode = yield* Config.string("RIKA_TEST_RESIDENT_MODE").pipe(Config.withDefault("legacy"))
  const endpoint = yield* resolve("default", dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const diagnostics = path.join(endpoint.canonicalDataRoot, "diagnostics")
  yield* fs.makeDirectory(diagnostics, { recursive: true, mode: 0o700 })
  const openLog = path.join(diagnostics, `resident-old-${process.pid}.open.jsonl`)
  const closedLog = openLog.replace(".open.jsonl", ".jsonl")
  if (recordPid) yield* fs.open(openLog, { flag: "ax", mode: 0o600 }).pipe(Effect.asVoid)
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: endpoint.port,
    fetch(request, upgradeServer) {
      const url = new URL(request.url)
      let acceptedPath = false
      if (mode === "legacy") acceptedPath = url.pathname === "/resident/v1"
      else if (mode === "schema-reject" || mode === "fake-incompatible" || mode === "v3" || mode === "legacy-v4")
        acceptedPath = url.pathname === "/resident" || url.pathname === "/resident/v1"
      if (!acceptedPath || !upgradeServer.upgrade(request)) return new Response(null, { status: 404 })
      return undefined
    },
    websocket: {
      message(socket, text) {
        if (mode === "schema-reject") {
          socket.close(4400)
          return
        }
        if (mode === "fake-incompatible" || mode === "v3") {
          socket.close(4406)
          return
        }
        if (mode === "legacy-v4") {
          const handshake = Schema.decodeUnknownSync(ResidentService.Handshake)(JSON.parse(String(text)))
          const response = {
            _tag: "incompatible" as const,
            disposition: "supersede" as const,
            family: "rika-resident" as const,
            identity: endpoint.identity,
            clientNonce: handshake.clientNonce,
            serviceNonce: `old-service-${process.pid}`,
            connectionId: `old-connection-${process.pid}`,
            protocolVersion: ResidentService.protocolVersion,
            buildIdentity: "rika-test-legacy-v4",
            residentPid: process.pid,
          }
          socket.send(
            JSON.stringify({
              ...response,
              serverProof: ResidentService.serverProof(token, handshake, response),
            } satisfies ResidentService.HandshakeIncompatible),
          )
          socket.close(4406)
          return
        }
        const message = JSON.parse(String(text)) as Record<string, unknown>
        if (
          message.family !== "rika-resident" ||
          message.identity !== endpoint.identity ||
          message.token !== token ||
          typeof message.clientNonce !== "string"
        ) {
          socket.close(4401)
          return
        }
        socket.send(
          JSON.stringify({
            _tag: "accepted",
            family: "rika-resident",
            version: { major: 1, minor: 0 },
            identity: endpoint.identity,
            clientNonce: message.clientNonce,
            serviceNonce: `old-service-${process.pid}`,
            connectionId: `old-connection-${process.pid}`,
            state: "ready",
            capabilities: ["ping", "startup-state", "transcript-pages", "interactive-ack"],
          }),
        )
      },
    },
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => host.stop(true)).pipe(
      Effect.andThen(recordPid ? fs.rename(openLog, closedLog).pipe(Effect.ignore) : Effect.void),
      Effect.andThen(
        fs.writeFileString(path.join(endpoint.canonicalDataRoot, "old-resident-stopped"), `${process.pid}\n`, {
          mode: 0o600,
        }),
      ),
      Effect.ignore,
    ),
  )
  yield* fs.writeFileString(path.join(endpoint.canonicalDataRoot, "old-resident-ready"), `${process.pid}\n`, {
    mode: 0o600,
  })
  yield* Effect.callback<void>((resume) => {
    const stop = () => resume(Effect.void)
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    return Effect.sync(() => {
      process.off("SIGTERM", stop)
      process.off("SIGINT", stop)
    })
  })
})

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.mergeAll(BunServices.layer, BunCrypto.layer, Logger.layer([])))
      yield* Effect.provide(program, context)
    }),
  ),
)
