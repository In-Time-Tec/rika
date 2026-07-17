import { Cause, Deferred, Effect, Fiber, Queue, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { Sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"

const ReadyMessage = Schema.Struct({ type: Schema.Literal("ready"), pid: Schema.Int })
const ScreenReadyMessage = Schema.Struct({ type: Schema.Literal("screen-ready"), pid: Schema.Int })
const ActionSnapshot = Schema.Struct({
  actionIndex: Schema.Int,
  actionType: Schema.String,
  timestampMilliseconds: Schema.Int,
  rows: Schema.Int,
  columns: Schema.Int,
  screen: Schema.String,
})
const ProbeLatency = Schema.Struct({
  actionIndex: Schema.Int,
  marker: Schema.String,
  latencyMilliseconds: Schema.Int,
  observed: Schema.Boolean,
})
const ActionTiming = {
  atMilliseconds: Schema.Number,
  expectedMarker: Schema.optional(Schema.String),
  markerTimeoutMilliseconds: Schema.optional(Schema.Number),
}
const PackagedPtyActionSchema = Schema.Union([
  Schema.Struct({ ...ActionTiming, type: Schema.Literal("write"), text: Schema.String }),
  Schema.Struct({ ...ActionTiming, type: Schema.Literal("write"), bytes: Schema.Array(Schema.Int) }),
  Schema.Struct({
    ...ActionTiming,
    type: Schema.Literal("write"),
    key: Schema.Literals(["enter", "escape", "tab", "backspace", "up", "down", "left", "right", "ctrl-c", "ctrl-t"]),
  }),
  Schema.Struct({ ...ActionTiming, type: Schema.Literal("resize"), rows: Schema.Int, columns: Schema.Int }),
  Schema.Struct({ ...ActionTiming, type: Schema.Literal("signal"), signal: Schema.Literals(["stop", "continue"]) }),
  Schema.Struct({ ...ActionTiming, type: Schema.Literal("probe") }),
])
const ResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  pid: Schema.Int,
  capture: Schema.String,
  exitCode: Schema.Int,
  observedTarget: Schema.Boolean,
  confirmedCycles: Schema.Int,
  requestedCycles: Schema.Int,
  durationMilliseconds: Schema.Int,
  snapshots: Schema.Array(ActionSnapshot),
  probeLatencies: Schema.Array(ProbeLatency),
  finalRows: Schema.Int,
  finalColumns: Schema.Int,
})
const Message = Schema.fromJsonString(Schema.Union([ReadyMessage, ScreenReadyMessage, ResultMessage]))

export type PackagedPtyResult = typeof ResultMessage.Type & { readonly captureText: string }

export interface PackagedPtyClient {
  readonly helperPid: number
  readonly processPid: number
  readonly result: Effect.Effect<PackagedPtyResult>
  readonly stop: Effect.Effect<PackagedPtyResult>
}

export interface PackagedPtyOptions {
  readonly arguments?: ReadonlyArray<string>
  readonly durationMilliseconds?: number
  readonly target?: string
  readonly readyTarget?: string
  readonly readyTimeoutMilliseconds?: number
  readonly gracefulStopMilliseconds?: number
  readonly rows?: number
  readonly columns?: number
  readonly actions?: ReadonlyArray<PackagedPtyAction>
  readonly cycle?: {
    readonly count: number
    readonly stepDelayMilliseconds?: number
    readonly targets: ReadonlyArray<{ readonly query: string; readonly marker: string }>
  }
}

export type PackagedPtyAction = {
  readonly atMilliseconds: number
  readonly expectedMarker?: string
  readonly markerTimeoutMilliseconds?: number
} & (
  | { readonly type: "write"; readonly text: string }
  | { readonly type: "write"; readonly bytes: ReadonlyArray<number> }
  | {
      readonly type: "write"
      readonly key: "enter" | "escape" | "tab" | "backspace" | "up" | "down" | "left" | "right" | "ctrl-c" | "ctrl-t"
    }
  | { readonly type: "resize"; readonly rows: number; readonly columns: number }
  | { readonly type: "signal"; readonly signal: "stop" | "continue" }
  | { readonly type: "probe" }
)

const environmentFor = (context: Sandbox) =>
  Object.fromEntries(
    Object.entries({
      HOME: context.env.HOME,
      PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      RIKA_DATABASE: context.env.RIKA_DATABASE,
      RIKA_RELAY_DATABASE: context.env.RIKA_RELAY_DATABASE,
      RIKA_TEST_MODEL_RESPONSE: context.env.RIKA_TEST_MODEL_RESPONSE,
      RIKA_TEST_MODEL_SCRIPT: context.env.RIKA_TEST_MODEL_SCRIPT,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )

export const startPackagedPty = Effect.fn("PackagedPty.start")(function* (
  context: Sandbox,
  options: PackagedPtyOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const sampler = yield* ResourceSampler.Service
  const input = yield* Queue.bounded<string, Cause.Done>(4)
  const ready = yield* Deferred.make<number>()
  const screenReady = yield* Deferred.make<void>()
  const result = yield* Deferred.make<PackagedPtyResult>()
  const stderr = yield* Ref.make<ReadonlyArray<string>>([])
  const helper = new URL("stress-pty.py", import.meta.url).pathname
  const actions = yield* Schema.decodeUnknownEffect(Schema.Array(PackagedPtyActionSchema))(options.actions ?? [])
  const encodedOptions = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({
    arguments: options.arguments ?? [],
    durationMs: options.durationMilliseconds ?? 30_000,
    readyTimeoutMs: options.readyTimeoutMilliseconds ?? 10_000,
    gracefulStopMs: options.gracefulStopMilliseconds ?? 2_000,
    rows: options.rows ?? 40,
    columns: options.columns ?? 120,
    actions,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.readyTarget === undefined ? {} : { readyTarget: options.readyTarget }),
    ...(options.cycle === undefined
      ? {}
      : {
          cycle: {
            count: options.cycle.count,
            stepDelayMs: options.cycle.stepDelayMilliseconds ?? 175,
            targets: options.cycle.targets,
          },
        }),
  })
  const encodedEnvironment = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(environmentFor(context))
  const handle = yield* spawner.spawn(
    ChildProcess.make("python3", [helper, context.binary, context.workspace, encodedEnvironment, encodedOptions], {
      cwd: context.workspace,
      detached: true,
      stdin: { stream: Stream.fromQueue(input).pipe(Stream.encodeText), endOnDone: true },
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  yield* sampler.track([Number(handle.pid)])
  const stdoutFiber = yield* Effect.forkScoped(
    handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Message)(line).pipe(
          Effect.flatMap((message) =>
            message.type === "ready"
              ? Deferred.succeed(ready, message.pid)
              : message.type === "screen-ready"
                ? Deferred.succeed(screenReady, undefined)
                : Deferred.succeed(result, {
                    ...message,
                    captureText: Buffer.from(message.capture, "base64").toString("utf8"),
                  }),
          ),
          Effect.ignore,
        ),
      ),
    ),
  )
  const stderrFiber = yield* Effect.forkScoped(
    handle.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Ref.update(stderr, (lines) => [...lines, line])),
    ),
  )
  const processPid = yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.die(`Packaged PTY helper ${handle.pid} did not start`),
    }),
  )
  yield* sampler.track([processPid])
  if (options.readyTarget !== undefined)
    yield* Deferred.await(screenReady).pipe(
      Effect.timeoutOrElse({
        duration: options.readyTimeoutMilliseconds ?? 10_000,
        orElse: () => Effect.die(`Packaged PTY ${processPid} did not render ${options.readyTarget}`),
      }),
    )
  const stopped = yield* Ref.make(false)
  const awaitResult = Effect.gen(function* () {
    const completed = yield* Deferred.await(result).pipe(
      Effect.timeoutOrElse({
        duration: "45 seconds",
        orElse: () =>
          Ref.get(stderr).pipe(
            Effect.flatMap((lines) => Effect.die(`Packaged PTY ${processPid} did not stop: ${lines.join("\n")}`)),
          ),
      }),
    )
    yield* Queue.end(input)
    yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)], { concurrency: 2, discard: true }).pipe(
      Effect.orDie,
    )
    return completed
  })
  const stop = Effect.gen(function* () {
    if (!(yield* Deferred.isDone(result)) && !(yield* Ref.get(stopped))) {
      yield* handle.kill({ killSignal: "SIGTERM" }).pipe(Effect.orDie)
      yield* Ref.set(stopped, true)
    }
    return yield* awaitResult
  })
  yield* Effect.addFinalizer(() => stop.pipe(Effect.ignore))
  return { helperPid: Number(handle.pid), processPid, result: awaitResult, stop } satisfies PackagedPtyClient
})
