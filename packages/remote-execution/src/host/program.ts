import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Crypto, Deferred, Effect, Encoding, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ExecutorBootstrapWire } from "../protocol/messages"
import { hostIdentity, type Bootstrap } from "./identity"
import { NativeToolError, NativeToolState, type NativeToolState as NativeToolStateValue } from "./machinery/native-tool"

const statePersistence = (stateDirectory: string, crypto: Crypto.Crypto, fileSystem: FileSystem.FileSystem) => {
  const nativeToolDirectory = `${stateDirectory}/native-tools`
  const decodeNativeTool = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeToolState))
  const encodeNativeTool = Schema.encodeEffect(Schema.fromJsonString(NativeToolState))
  const nativeToolPath = Effect.fn("Host.nativeToolStatePath")(function* (operationId: string) {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(operationId))
      .pipe(Effect.mapError(() => NativeToolError.make({ message: "Could not identify native tool state" })))
    return `${nativeToolDirectory}/${Encoding.encodeHex(digest)}.json`
  })
  const readNativeTool = Effect.fn("Host.readNativeToolState")(function* (operationId: string) {
    const filename = yield* nativeToolPath(operationId)
    const exists = yield* fileSystem
      .exists(filename)
      .pipe(Effect.mapError(() => NativeToolError.make({ message: "Could not inspect native tool state" })))
    if (!exists) return undefined
    const text = yield* fileSystem
      .readFileString(filename)
      .pipe(Effect.mapError(() => NativeToolError.make({ message: "Could not read native tool state" })))
    return yield* decodeNativeTool(text).pipe(
      Effect.mapError(() => NativeToolError.make({ message: "Native tool state is invalid" })),
    )
  })
  const writeNativeTool = Effect.fn("Host.writeNativeToolState")(function* (
    operationId: string,
    state: NativeToolStateValue,
  ) {
    const filename = yield* nativeToolPath(operationId)
    const temporary = `${filename}.tmp-${process.pid}`
    const text = yield* encodeNativeTool(state).pipe(
      Effect.mapError(() => NativeToolError.make({ message: "Could not encode native tool state" })),
    )
    yield* fileSystem
      .makeDirectory(nativeToolDirectory, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => NativeToolError.make({ message: "Could not create native tool state" })))
    yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 }).pipe(
      Effect.flatMap(() => fileSystem.rename(temporary, filename)),
      Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(() => NativeToolError.make({ message: "Could not persist native tool state" })),
    )
  })
  return { readNativeTool, writeNativeTool }
}

export const receiveBootstrap = Effect.scoped(
  Effect.flatMap(Layer.build(BunServices.layer), (services) =>
    Effect.gen(function* () {
      let consumed = false
      const completed = yield* Deferred.make<Bootstrap>()
      const server = yield* BunHttpServer.make({ hostname: "0.0.0.0", port: 7070, idleTimeout: 1 })
      const app = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = new URL(request.url, "http://localhost").pathname
        if (path === "/health") return HttpServerResponse.text("ready")
        if (path !== "/.rika/bootstrap" || request.method !== "POST" || consumed)
          return HttpServerResponse.text("not found", { status: 404 })
        const [bodyOption, instanceId, stateDirectory] = yield* Effect.all([
          HttpServerRequest.schemaBodyJson(ExecutorBootstrapWire).pipe(Effect.option),
          hostIdentity.sandboxInstanceId,
          Config.string("RIKA_EXECUTOR_STATE_DIRECTORY").pipe(Config.withDefault(hostIdentity.executorStateDirectory)),
        ])
        const body = Option.getOrUndefined(bodyOption)
        if (body === undefined || instanceId.length === 0 || body.identity.instanceId !== instanceId)
          return HttpServerResponse.text("invalid", { status: 400 })
        if (consumed) return HttpServerResponse.text("not found", { status: 404 })
        consumed = true
        yield* Deferred.succeed(completed, {
          credential: Redacted.make(body.credential, { label: "executor-bootstrap" }),
          identity: { ...body.identity, stateDirectory },
          seed: body.seed,
          restore: body.restore,
        })
        return HttpServerResponse.text("accepted", { status: 202 })
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("invalid", { status: 400 })))
      yield* server.serve(app).pipe(Effect.forkScoped)
      return yield* Deferred.await(completed)
    }).pipe(Effect.provide(services)),
  ),
)

export const program = { receiveBootstrap, statePersistence } as const
