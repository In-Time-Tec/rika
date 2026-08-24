import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Config, Console, Data, Effect, Function, Layer, Result, Schema, Scope, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const synchronizedOutputBegin = "\u001b[?2026h"
const synchronizedOutputEnd = "\u001b[?2026l"
const outputLimit = 65_536
const gracefulExitMilliseconds = 1_000

export interface StartupSample {
  readonly sample: number
  readonly milliseconds: number
  readonly rssKilobytes: number
}

export interface StartupMeasurement {
  readonly version: 2
  readonly binary: string
  readonly samples: ReadonlyArray<StartupSample>
  readonly summary: {
    readonly min: number
    readonly p50: number
    readonly p95: number
    readonly max: number
  }
  readonly rssKilobytes: {
    readonly min: number
    readonly p50: number
    readonly p95: number
    readonly max: number
  }
}

export class StartupTimeoutError extends Data.Error<{ readonly message: string }> {
  override readonly name = "StartupTimeoutError"

  constructor(message: string) {
    super({ message })
  }
}

class StartupFrameError extends Data.Error<{ readonly message: string }> {}
class StartupProcessError extends Data.Error<{ readonly message: string }> {}
class StartupPromiseError extends Data.Error<{ readonly error: Error }> {}
class StartupFrameComplete extends Data.TaggedError("StartupFrameComplete")<{ readonly output: string }> {}

const awaitStartupPromise = Effect.fn("PackagedStartup.awaitPromise")(
  <A>(promise: () => ReturnType<typeof Effect.runPromise<A, never>>) =>
    Effect.tryPromise({
      try: promise,
      catch: (error) => new StartupPromiseError({ error: error instanceof Error ? error : new Error(String(error)) }),
    }),
)

export const percentile: {
  (values: ReadonlyArray<number>, ratio: number): number
  (ratio: number): (values: ReadonlyArray<number>) => number
} = Function.dual(2, (values: ReadonlyArray<number>, ratio: number): number => {
  if (values.length === 0) throw new TypeError("percentile values must not be empty")
  if (!values.every(Number.isFinite)) throw new TypeError("percentile values must be finite")
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    throw new TypeError("percentile ratio must be finite and between 0 and 1")
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!
})

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

export const scriptArguments: {
  (executable: string, arguments_?: ReadonlyArray<string>, platform?: NodeJS.Platform): Array<string>
  (arguments_?: ReadonlyArray<string>, platform?: NodeJS.Platform): (executable: string) => Array<string>
} = Function.dual(
  (arguments_) => typeof arguments_[0] === "string",
  (
    executable: string,
    arguments_: ReadonlyArray<string> = [],
    platform: NodeJS.Platform = process.platform,
  ): Array<string> => {
    if (platform === "darwin") return ["script", "-q", "/dev/null", executable, ...arguments_]
    if (platform === "linux")
      return ["script", "-qfec", `exec ${[executable, ...arguments_].map(shellQuote).join(" ")}`, "/dev/null"]
    throw new Error(`PTY probes are unsupported on ${platform}`)
  },
)

export const containsCompleteFrame = (output: string): boolean => {
  let offset = 0
  while (true) {
    const begin = output.indexOf(synchronizedOutputBegin, offset)
    if (begin < 0) return false
    const payload = begin + synchronizedOutputBegin.length
    const end = output.indexOf(synchronizedOutputEnd, payload)
    if (end < 0) return false
    if (end > payload) return true
    offset = end + synchronizedOutputEnd.length
  }
}

const PosixProcessGroupAdapter = {
  exists(processGroup: number): boolean {
    try {
      process.kill(-processGroup, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  },
  signal(processGroup: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-processGroup, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  },
}

const waitForGroupExit = Effect.fn("PackagedStartup.waitForGroupExit")(function* (
  processGroup: number,
  milliseconds: number,
) {
  const deadline = (yield* Clock.currentTimeMillis) + milliseconds
  while (PosixProcessGroupAdapter.exists(processGroup)) {
    if ((yield* Clock.currentTimeMillis) >= deadline) return false
    yield* Effect.sleep(10)
  }
  return true
})

const processTable = (columns: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make("ps", ["-axo", columns], { stderr: "pipe" }))
    const [stdout, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode], {
      concurrency: 2,
    })
    if (exitCode !== 0) return yield* new StartupProcessError({ message: "could not inspect process table" })
    return stdout
  })

const foregroundProcessGroup = (child: ChildProcessSpawner.ChildProcessHandle, milliseconds = 1_000) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + milliseconds
    while (true) {
      const rows = (yield* processTable("pid=,ppid=,pgid=")).split("\n").flatMap((line) => {
        const [pid, parent, processGroup] = line.trim().split(/\s+/).map(Number)
        return Number.isFinite(pid) && Number.isFinite(parent) && Number.isFinite(processGroup)
          ? [{ pid: pid!, parent: parent!, processGroup: processGroup! }]
          : []
      })
      const childPid = Number(child.pid)
      const descendants = new Set([childPid])
      for (let previousSize = -1; descendants.size !== previousSize; ) {
        previousSize = descendants.size
        for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid)
      }
      const foreground = rows.find((row) => descendants.has(row.pid) && row.processGroup !== childPid)
      if (foreground !== undefined && foreground.processGroup > 0) return foreground.processGroup
      if (!(yield* child.isRunning))
        return yield* new StartupProcessError({ message: `could not identify process group for ${child.pid}` })
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* new StartupProcessError({ message: `could not identify process group for ${child.pid}` })
      yield* Effect.sleep(10)
    }
  })

interface ProcessRow {
  readonly pid: number
  readonly parent: number
  readonly rssKilobytes: number
}

export const processTreeRss: {
  (rootParent: number, rows: ReadonlyArray<ProcessRow>): number
  (rows: ReadonlyArray<ProcessRow>): (rootParent: number) => number
} = Function.dual(2, (rootParent: number, rows: ReadonlyArray<ProcessRow>): number => {
  const pending = [rootParent]
  const included = new Set<number>()
  let total = 0
  while (pending.length > 0) {
    const parent = pending.pop()!
    for (const row of rows) {
      if (row.parent !== parent || included.has(row.pid)) continue
      included.add(row.pid)
      pending.push(row.pid)
      total += row.rssKilobytes
    }
  }
  return total
})

const inspectProcessTreeRss = (rootParent: number) =>
  Effect.gen(function* () {
    const rows = (yield* processTable("pid=,ppid=,rss=")).split("\n").flatMap((line) => {
      const [pid, parent, rssKilobytes] = line.trim().split(/\s+/).map(Number)
      return Number.isFinite(pid) && Number.isFinite(parent) && Number.isFinite(rssKilobytes)
        ? [{ pid: pid!, parent: parent!, rssKilobytes: rssKilobytes! }]
        : []
    })
    const rssKilobytes = processTreeRss(rootParent, rows)
    if (rssKilobytes <= 0)
      return yield* new StartupProcessError({
        message: `packaged process tree for ${rootParent} had no resident memory`,
      })
    return rssKilobytes
  })

const terminate = Effect.fn("PackagedStartup.terminate")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  processGroup: number,
) {
  if (PosixProcessGroupAdapter.exists(processGroup)) PosixProcessGroupAdapter.signal(processGroup, "SIGTERM")
  const exited = yield* waitForGroupExit(processGroup, gracefulExitMilliseconds)
  if (!exited) {
    PosixProcessGroupAdapter.signal(processGroup, "SIGKILL")
    const killed = yield* waitForGroupExit(processGroup, gracefulExitMilliseconds)
    if (!killed) return yield* new StartupProcessError({ message: `process group ${processGroup} survived SIGKILL` })
  }
  yield* Effect.ignore(child.exitCode)
})

const terminateSpawn = (
  child: ChildProcessSpawner.ChildProcessHandle,
  foregroundGroup: number | undefined,
): Effect.Effect<void, StartupProcessError> =>
  terminate(child, foregroundGroup !== undefined && foregroundGroup !== child.pid ? foregroundGroup : child.pid)

const runWithCleanupImpl = <Value>(
  operation: () => ReturnType<typeof Effect.runPromise<Value, never>>,
  cleanup: () => ReturnType<typeof Effect.runPromise<void, never>>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const operationResult = yield* Effect.result(awaitStartupPromise(operation))
      const cleanupResult = yield* Effect.result(awaitStartupPromise(cleanup))
      if (Result.isFailure(operationResult)) {
        const primary = operationResult.failure.error
        if (Result.isFailure(cleanupResult))
          Object.defineProperty(primary, "cause", { value: cleanupResult.failure.error, configurable: true })
        return yield* Effect.die(primary)
      }
      if (Result.isFailure(cleanupResult)) return yield* Effect.die(cleanupResult.failure.error)
      return operationResult.success
    }),
  )

export const runWithCleanup: {
  <Value>(
    operation: Parameters<typeof runWithCleanupImpl<Value>>[0],
    cleanup: Parameters<typeof runWithCleanupImpl<Value>>[1],
  ): ReturnType<typeof runWithCleanupImpl<Value>>
  <Value>(
    cleanup: Parameters<typeof runWithCleanupImpl<Value>>[1],
  ): (operation: Parameters<typeof runWithCleanupImpl<Value>>[0]) => ReturnType<typeof runWithCleanupImpl<Value>>
} = Function.dual(2, runWithCleanupImpl)

const benchmarkEnvironment = (overrides: Readonly<Record<string, string>>): Record<string, string> => {
  const optional = (name: string) =>
    Effect.runSync(Config.option(Config.string(name))).pipe((value) =>
      value._tag === "Some" ? value.value : undefined,
    )
  const environment: Record<string, string> = {
    PATH: optional("PATH") ?? "/usr/bin:/bin",
    HOME: optional("HOME") ?? process.cwd(),
    TERM: "xterm-256color",
    COLUMNS: "100",
    LINES: "30",
  }
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "RIKA_API_URL", "RIKA_AUTH_TOKEN"]) {
    const value = optional(name)
    if (value !== undefined) environment[name] = value
  }
  return { ...environment, ...overrides }
}

export interface PtyFrameProbe {
  readonly output: string
  readonly exitCode: number
}

export type PtyFrameInterrupt = "foreground-process-group-sigint" | "terminal-control-c"

export interface PtyFrameProbeOptions {
  readonly arguments?: ReadonlyArray<string>
  readonly timeoutMilliseconds?: number
  readonly environment?: Readonly<Record<string, string>>
  readonly interrupt: PtyFrameInterrupt
}

const resolveExecutable = (binary: string): string =>
  binary.startsWith("/") ? binary : decodeURIComponent(new URL(binary, Bun.pathToFileURL(`${process.cwd()}/`)).pathname)

const withTimeout = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
  milliseconds: number,
  message: string,
) =>
  effect.pipe(
    Effect.timeout(milliseconds),
    Effect.catchTag("TimeoutError", () => new StartupTimeoutError(message)),
  )

const readCompleteFrame = (child: ChildProcessSpawner.ChildProcessHandle, executable: string) => {
  let output = ""
  return Stream.decodeText(child.stdout).pipe(
    Stream.runForEach((text) =>
      Effect.sync(() => {
        output = `${output}${text}`.slice(-outputLimit)
        return containsCompleteFrame(output)
      }).pipe(
        Effect.flatMap((complete) => (complete ? Effect.fail(new StartupFrameComplete({ output })) : Effect.void)),
      ),
    ),
    Effect.andThen(
      new StartupFrameError({
        message: `process exited before its first complete OpenTUI frame: ${executable}\n${output}`,
      }),
    ),
    Effect.catchTag("StartupFrameComplete", ({ output: completeOutput }) => Effect.succeed(completeOutput)),
  )
}

const runPlatform = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(effect, context))),
  )

const probePtyFrameAndInterruptImpl = (binary: string, options: PtyFrameProbeOptions) =>
  runPlatform(
    Effect.gen(function* () {
      const { arguments: arguments_ = [], timeoutMilliseconds = 30_000, environment = {}, interrupt } = options
      const executable = resolveExecutable(binary)
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const [command, ...args] = scriptArguments(executable, arguments_)
      const child = yield* spawner.spawn(
        ChildProcess.make(command!, args, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
          env: benchmarkEnvironment(environment),
        }),
      )
      let processGroup: number | undefined
      return yield* Effect.gen(function* () {
        processGroup = yield* foregroundProcessGroup(child)
        const output = yield* readCompleteFrame(child, executable)
        if (interrupt === "foreground-process-group-sigint") PosixProcessGroupAdapter.signal(processGroup, "SIGINT")
        else yield* Stream.run(Stream.make(new TextEncoder().encode("\u0003")), child.stdin)
        const exitCode = yield* child.exitCode
        return { output, exitCode: Number(exitCode) }
      }).pipe(
        (effect) =>
          withTimeout(effect, timeoutMilliseconds, `PTY probe timed out after ${timeoutMilliseconds}ms: ${executable}`),
        Effect.ensuring(terminateSpawn(child, processGroup).pipe(Effect.orDie)),
      )
    }),
  )

export const probePtyFrameAndInterrupt: {
  (binary: string, options: PtyFrameProbeOptions): ReturnType<typeof probePtyFrameAndInterruptImpl>
  (options: PtyFrameProbeOptions): (binary: string) => ReturnType<typeof probePtyFrameAndInterruptImpl>
} = Function.dual(2, probePtyFrameAndInterruptImpl)

const measureStartupImpl = (
  binary: string,
  sampleCount: number,
  timeoutMilliseconds = 30_000,
  environment: Readonly<Record<string, string>> = {},
) => {
  if (!Number.isInteger(sampleCount) || sampleCount < 1)
    return Effect.runPromise(Effect.fail(new StartupProcessError({ message: "samples must be a positive integer" })))
  return runPlatform(
    Effect.gen(function* () {
      const executable = resolveExecutable(binary)
      const samples: Array<StartupSample> = []
      for (let sample = 1; sample <= sampleCount; sample++) {
        const started = yield* Clock.currentTimeNanos
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const [command, ...args] = scriptArguments(executable)
        const child = yield* spawner.spawn(
          ChildProcess.make(command!, args, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
            env: benchmarkEnvironment(environment),
          }),
        )
        let processGroup: number | undefined
        yield* Effect.gen(function* () {
          processGroup = yield* foregroundProcessGroup(child)
          yield* readCompleteFrame(child, executable)
          samples.push({
            sample,
            milliseconds: Number((yield* Clock.currentTimeNanos) - started) / 1_000_000,
            rssKilobytes: yield* inspectProcessTreeRss(child.pid),
          })
        }).pipe(
          (effect) =>
            withTimeout(effect, timeoutMilliseconds, `startup timed out after ${timeoutMilliseconds}ms: ${executable}`),
          Effect.ensuring(terminateSpawn(child, processGroup).pipe(Effect.orDie)),
        )
      }
      const values = samples.map(({ milliseconds }) => milliseconds)
      const rssValues = samples.map(({ rssKilobytes }) => rssKilobytes)
      return {
        version: 2,
        binary: executable,
        samples,
        summary: {
          min: Math.min(...values),
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: Math.max(...values),
        },
        rssKilobytes: {
          min: Math.min(...rssValues),
          p50: percentile(rssValues, 0.5),
          p95: percentile(rssValues, 0.95),
          max: Math.max(...rssValues),
        },
      }
    }),
  )
}

export const measureStartup: {
  (
    binary: string,
    sampleCount: number,
    timeoutMilliseconds?: number,
    environment?: Readonly<Record<string, string>>,
  ): ReturnType<typeof measureStartupImpl>
  (
    sampleCount: number,
    timeoutMilliseconds?: number,
    environment?: Readonly<Record<string, string>>,
  ): (binary: string) => ReturnType<typeof measureStartupImpl>
} = Function.dual((arguments_) => typeof arguments_[0] === "string", measureStartupImpl)

const command = Command.make(
  "packaged-startup",
  {
    binary: Flag.string("binary"),
    samples: Flag.integer("samples").pipe(Flag.withDefault(10)),
  },
  ({ binary, samples }) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() => measureStartup(binary, samples))
      yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result))
    }),
)

const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
