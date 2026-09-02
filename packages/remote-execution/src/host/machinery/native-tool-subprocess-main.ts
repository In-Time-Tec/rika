import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as LocalTools from "@rika/execution/local-tools"
import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import * as NativeToolSubprocess from "./native-tool-subprocess"
import { Context, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeToolSubprocess.wire.Request))
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(NativeToolSubprocess.wire.Response))

interface SocketState {
  text: string
  running: boolean
  closed: boolean
  decoder: TextDecoder
  fiber?: Fiber.Fiber<string>
}

interface PendingRequest {
  readonly socket: Bun.Socket<SocketState>
  readonly text: string
}

const RequestEnvironment = Context.Reference<Readonly<Record<string, string>>>(
  "@rika/remote-execution/host/native-tool-subprocess/RequestEnvironment",
  { defaultValue: () => ({}) },
)

const serve = Effect.fn("NativeToolSubprocess.serve")(function* (workspace: string, socketPath: string) {
  const platform = yield* Effect.context<BunServices.BunServices>()
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.remove(socketPath, { force: true })
  const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner)
  const processLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.flatMap(RequestEnvironment, (environment) => spawner.spawn(ChildProcess.setEnv(command, environment))),
    ),
  )
  const context = yield* Layer.build(
    Layer.effect(NativeToolRuntime.Service, Effect.map(NativeToolRuntime.Service, NativeToolRuntime.Service.of)).pipe(
      Layer.provide(LocalTools.layer(workspace)),
      Layer.provide(Layer.merge(Layer.succeedContext(platform), processLayer)),
    ),
  )
  const execute = (text: string) =>
    decodeRequest(text).pipe(
      Effect.flatMap((input) =>
        Effect.flatMap(NativeToolRuntime.Service, (runtime) => runtime.run(input.request)).pipe(
          Effect.match({
            onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
            onSuccess: (result) => ({ _tag: "Success" as const, value: { _tag: "NativeTool" as const, result } }),
          }),
          Effect.provideService(RequestEnvironment, input.environment),
        ),
      ),
      Effect.map((outcome) => encodeResponse({ outcome })),
      Effect.orElseSucceed(() => encodeResponse({ error: "Native tool subprocess request failed" })),
      Effect.provide(context),
    )
  const buffered: Array<PendingRequest> = []
  let waiting: ((effect: Effect.Effect<PendingRequest>) => void) | undefined
  const offer = (request: PendingRequest) => {
    const resume = waiting
    if (resume === undefined) buffered.push(request)
    else {
      waiting = undefined
      resume(Effect.succeed(request))
    }
  }
  const take = Effect.callback<PendingRequest>((resume) => {
    const request = buffered.shift()
    if (request === undefined) waiting = resume
    else resume(Effect.succeed(request))
    return Effect.sync(() => {
      if (waiting === resume) waiting = undefined
    })
  })
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.listen<SocketState>({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.data = { text: "", running: false, closed: false, decoder: new TextDecoder() }
          },
          data(socket, chunk) {
            if (socket.data.running) return
            socket.data.text += socket.data.decoder.decode(chunk, { stream: true })
            const newline = socket.data.text.indexOf("\n")
            if (newline < 0) return
            socket.data.running = true
            const request = socket.data.text.slice(0, newline)
            offer({ socket, text: request })
          },
          close(socket) {
            socket.data.closed = true
            socket.data.fiber?.interruptUnsafe()
          },
        },
      }),
    ),
    (server) =>
      Effect.sync(() => server.stop(true)).pipe(
        Effect.andThen(fileSystem.remove(socketPath, { force: true }).pipe(Effect.ignore)),
      ),
  )
  yield* fileSystem.chmod(socketPath, 0o660)
  return yield* Effect.forever(
    take.pipe(
      Effect.flatMap(({ socket, text }) =>
        socket.data.closed
          ? Effect.void
          : execute(text).pipe(
              Effect.tap((response) =>
                Effect.sync(() => {
                  socket.end(`${response}\n`)
                }),
              ),
              Effect.forkChild,
              Effect.tap((fiber) =>
                Effect.sync(() => {
                  socket.data.fiber = fiber
                  if (socket.data.closed) fiber.interruptUnsafe()
                }),
              ),
              Effect.asVoid,
            ),
      ),
    ),
  )
})

const command = Command.make(
  "native-tool-subprocess",
  {
    workspace: Argument.string("workspace"),
    socketPath: Argument.string("socket-path"),
  },
  ({ workspace, socketPath }) => serve(workspace, socketPath),
)
const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
