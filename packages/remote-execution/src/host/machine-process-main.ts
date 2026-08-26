import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as MachineExecution from "./machine-execution"
import * as MachineProcess from "./machine-process"
import { Context, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(MachineProcess.wire.Request))
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(MachineProcess.wire.Response))

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
  "@rika/remote-execution/host/machine-process/RequestEnvironment",
  { defaultValue: () => ({}) },
)

const serve = Effect.fn("MachineProcess.serve")(function* (workspace: string, socketPath: string) {
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
    MachineExecution.layer(workspace).pipe(Layer.provide(Layer.merge(Layer.succeedContext(platform), processLayer))),
  )
  const execute = (text: string) =>
    decodeRequest(text).pipe(
      Effect.flatMap((input) =>
        MachineExecution.execute(input.request).pipe(Effect.provideService(RequestEnvironment, input.environment)),
      ),
      Effect.map((outcome) => encodeResponse({ outcome })),
      Effect.orElseSucceed(() => encodeResponse({ error: "Workspace machine request failed" })),
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
  "machine-process",
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
