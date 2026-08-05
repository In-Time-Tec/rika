import * as ServerService from "@rika/product/server-service"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Effect, Option, Schema, Stream } from "effect"

const StartupMessage = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("ready") }),
  Schema.Struct({ _tag: Schema.tag("failed"), message: Schema.String }),
])

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StartupMessage))
const startupFdEnvironment = "RIKA_INTERNAL_SERVER_STARTUP_FD"
const startupFd = 3

const startupError = (reason: "startup-failed" | "transport-failed", cause: unknown) =>
  ServerService.ServerServiceError.make({ reason, message: String(cause) })

const awaitStartup = <E>(output: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(
    Stream.splitLines(Stream.decodeText(output)),
    () => Option.none<string>(),
    (first, text) => (Option.isSome(first) ? first : Option.some(text)),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(startupError("startup-failed", "Server startup signal timed out")),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(startupError("startup-failed", "Server startup signal ended without a message")),
        onSome: (text) => decode(text).pipe(Effect.mapError((cause) => startupError("startup-failed", cause))),
      }),
    ),
    Effect.flatMap((message) =>
      message._tag === "ready" ? Effect.void : Effect.fail(startupError("startup-failed", message.message)),
    ),
    Effect.mapError((cause) =>
      Schema.is(ServerService.ServerServiceError)(cause) ? cause : startupError("startup-failed", cause),
    ),
  )

export const spawn = Effect.fn("ServerProcessStartup.spawn")(function* (options: {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly cwd?: string
  readonly environment: Readonly<Record<string, string | undefined>>
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(options.executable, options.arguments, {
        detached: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        additionalFds: { fd3: { type: "output" } },
        extendEnv: true,
        env: { ...options.environment, [startupFdEnvironment]: String(startupFd) },
      }),
    )
    .pipe(Effect.mapError((cause) => startupError("transport-failed", cause)))
  return {
    pid: Number(handle.pid),
    startup: awaitStartup(handle.getOutputFd(startupFd)),
    detach: handle.unref.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => startupError("transport-failed", cause)),
    ),
    abort: handle
      .kill({ killSignal: "SIGKILL" })
      .pipe(Effect.andThen(handle.exitCode), Effect.timeout("2 seconds"), Effect.ignore),
  } satisfies ServerService.StartedHost
})
