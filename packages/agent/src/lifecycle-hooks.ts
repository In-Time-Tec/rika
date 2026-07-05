import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Context, Effect, Layer, Option, Queue, Schema, Stream, type Duration } from "effect"

export const HookName = Schema.Literals(["setup", "resume"]).annotate({
  identifier: "Rika.Agent.LifecycleHooks.HookName",
})
export type HookName = typeof HookName.Type

export const HookOutputSource = Schema.Literals(["stdout", "stderr"]).annotate({
  identifier: "Rika.Agent.LifecycleHooks.HookOutputSource",
})
export type HookOutputSource = typeof HookOutputSource.Type

export interface HookOutputLine extends Schema.Schema.Type<typeof HookOutputLine> {}
export const HookOutputLine = Schema.Struct({
  source: HookOutputSource,
  line: Schema.String,
}).annotate({ identifier: "Rika.Agent.LifecycleHooks.HookOutputLine" })

export const HookResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("skipped") }),
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({ status: Schema.Literal("failed"), exitCode: Schema.Int }),
  Schema.Struct({ status: Schema.Literal("detached") }),
]).annotate({ identifier: "Rika.Agent.LifecycleHooks.HookResult" })
export type HookResult = typeof HookResult.Type

export class HookError extends Schema.TaggedErrorClass<HookError>()("HookError", {
  hook: HookName,
  path: Schema.String,
  workspaceRoot: Schema.String,
  message: Schema.String,
  exitCode: Schema.optional(Schema.Int),
  lastOutput: Schema.optional(Schema.Array(HookOutputLine)),
}) {}

export interface Interface {
  readonly runSetup: (workspaceRoot: string) => Stream.Stream<HookOutputLine, HookError>
  readonly runResume: (workspaceRoot: string) => Effect.Effect<HookResult, HookError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/LifecycleHooks") {}

export interface LayerOptions {
  readonly setupTimeout?: Duration.Input
  readonly resumeTimeout?: Duration.Input
}

const defaultSetupTimeout: Duration.Input = "5 minutes"
const defaultResumeTimeout: Duration.Input = "10 seconds"
const processTerminationGrace: Duration.Input = "1 second"

export const layerWithOptions = (options: LayerOptions = {}) =>
  Layer.succeed(
    Service,
    makeService(options.setupTimeout ?? defaultSetupTimeout, options.resumeTimeout ?? defaultResumeTimeout),
  )

export const layer = layerWithOptions()

export const runSetup = (workspaceRoot: string) =>
  Stream.unwrap(Effect.map(Service, (service) => service.runSetup(workspaceRoot)))

export const runResume = Effect.fn("LifecycleHooks.runResume.call")(function* (workspaceRoot: string) {
  const service = yield* Service
  return yield* service.runResume(workspaceRoot)
})

function makeService(setupTimeout: Duration.Input, resumeTimeout: Duration.Input): Interface {
  return Service.of({
    runSetup: (workspaceRoot) => {
      const root = resolve(workspaceRoot)
      return Stream.unwrap(
        preflight("setup", root).pipe(
          Effect.map((hook) => (hook.status === "missing" ? Stream.empty : streamSetup(root, hook.path, setupTimeout))),
        ),
      )
    },
    runResume: Effect.fn("LifecycleHooks.runResume")(function* (workspaceRoot) {
      const root = resolve(workspaceRoot)
      const hook = yield* preflight("resume", root)
      if (hook.status === "missing") return { status: "skipped" } as const

      const process = yield* spawnResume(root, hook.path)
      const exit = yield* waitForExit(process, "resume", root, hook.path).pipe(Effect.timeoutOption(resumeTimeout))
      if (Option.isNone(exit)) {
        process.unref()
        return { status: "detached" } as const
      }
      return exit.value === 0 ? ({ status: "ok" } as const) : ({ status: "failed", exitCode: exit.value } as const)
    }),
  })
}

const streamSetup = (
  workspaceRoot: string,
  path: string,
  setupTimeout: Duration.Input,
): Stream.Stream<HookOutputLine, HookError> =>
  Stream.callback<HookOutputLine, HookError>(
    (queue) =>
      setupProcessStream(workspaceRoot, path).pipe(
        Stream.runForEach((line) => Queue.offer(queue, line).pipe(Effect.asVoid)),
        Effect.timeoutOrElse({
          duration: setupTimeout,
          orElse: () => Effect.fail(timeoutHookError("setup", workspaceRoot, path)),
        }),
        Effect.catch((error: HookError) => Queue.fail(queue, error).pipe(Effect.asVoid)),
        Effect.ensuring(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkScoped({ startImmediately: true }),
      ),
    { bufferSize: 64, strategy: "suspend" },
  )

const setupProcessStream = (workspaceRoot: string, path: string): Stream.Stream<HookOutputLine, HookError> =>
  Stream.scoped(
    Stream.unwrap(
      acquireSetupProcess(workspaceRoot, path).pipe(
        Effect.map((process) => {
          const lastOutput: Array<HookOutputLine> = []
          const stdout = outputLines(process.stdout, "stdout", "setup", workspaceRoot, path)
          const stderr = outputLines(process.stderr, "stderr", "setup", workspaceRoot, path)
          const output = stdout.pipe(
            Stream.merge(stderr),
            Stream.tap((line) =>
              Effect.sync(() => {
                lastOutput.push(line)
                if (lastOutput.length > 50) lastOutput.shift()
              }),
            ),
          )
          const exit = waitForExit(process, "setup", workspaceRoot, path).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                process.completed = true
              }),
            ),
            Effect.flatMap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Effect.fail(
                    new HookError({
                      hook: "setup",
                      path,
                      workspaceRoot,
                      message: `Lifecycle hook exited with code ${exitCode}`,
                      exitCode,
                      lastOutput: [...lastOutput],
                    }),
                  ),
            ),
          )
          return output.pipe(Stream.concat(Stream.fromEffectDrain(exit)))
        }),
      ),
    ),
  )

const preflight = Effect.fn("LifecycleHooks.preflight")(function* (hook: HookName, workspaceRoot: string) {
  const path = hookPath(workspaceRoot, hook)
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        const info = await stat(path)
        if (!info.isFile()) {
          throw new HookError({
            hook,
            path,
            workspaceRoot,
            message: "Lifecycle hook must be an executable file",
          })
        }
        if ((info.mode & 0o111) === 0) {
          throw new HookError({
            hook,
            path,
            workspaceRoot,
            message: "Lifecycle hook file must be executable",
          })
        }
        return { status: "ready", path } as const
      } catch (cause) {
        if (cause instanceof HookError) throw cause
        if (isNotFound(cause)) return { status: "missing", path } as const
        throw cause
      }
    },
    catch: (cause) =>
      cause instanceof HookError
        ? cause
        : new HookError({
            hook,
            path,
            workspaceRoot,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  })
})

interface SetupProcess {
  readonly process: {
    readonly pid: number
    readonly kill: (signal?: NodeJS.Signals) => void
  }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  completed: boolean
}

const acquireSetupProcess = (workspaceRoot: string, path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const process = Bun.spawn([path], {
          cwd: workspaceRoot,
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        })
        return {
          process,
          stdout: process.stdout,
          stderr: process.stderr,
          exited: process.exited,
          completed: false,
        }
      },
      catch: (cause) =>
        new HookError({
          hook: "setup",
          path,
          workspaceRoot,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
    (process) => (process.completed ? Effect.void : terminateProcess(process)),
  )

const spawnResume = (workspaceRoot: string, path: string) =>
  Effect.try({
    try: () =>
      Bun.spawn({
        cmd: [path],
        cwd: workspaceRoot,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    catch: (cause) =>
      new HookError({
        hook: "resume",
        path,
        workspaceRoot,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const outputLines = (
  body: ReadableStream<Uint8Array>,
  source: HookOutputSource,
  hook: HookName,
  workspaceRoot: string,
  path: string,
): Stream.Stream<HookOutputLine, HookError> =>
  Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) =>
      new HookError({
        hook,
        path,
        workspaceRoot,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.map((line) => ({ source, line })),
  )

const waitForExit = (
  process: { readonly exited: Promise<number> },
  hook: HookName,
  workspaceRoot: string,
  path: string,
) =>
  Effect.tryPromise({
    try: () => process.exited,
    catch: (cause) =>
      new HookError({
        hook,
        path,
        workspaceRoot,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const hookPath = (workspaceRoot: string, hook: HookName) => join(workspaceRoot, ".agents", hook)

const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

const timeoutHookError = (hook: HookName, workspaceRoot: string, path: string) =>
  new HookError({
    hook,
    path,
    workspaceRoot,
    message: "Lifecycle hook timed out",
  })

const terminateProcess = (process: SetupProcess) =>
  Effect.gen(function* () {
    killProcessGroup(process.process.pid, "SIGTERM")
    killProcess(process.process, "SIGTERM")
    const exited = yield* Effect.race(
      waitForProcessExit(process).pipe(Effect.as(true)),
      Effect.sleep(processTerminationGrace).pipe(Effect.as(false)),
    )
    if (exited) return
    killProcessGroup(process.process.pid, "SIGKILL")
    killProcess(process.process, "SIGKILL")
  })

const waitForProcessExit = (process: { readonly exited: Promise<number> }) =>
  Effect.promise(() => process.exited).pipe(Effect.asVoid)

const killProcessGroup = (pid: number, signal: NodeJS.Signals) => {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    globalThis.process.kill(-pid, signal)
  } catch {}
}

const killProcess = (process: SetupProcess["process"], signal: NodeJS.Signals) => {
  try {
    process.kill(signal)
  } catch {}
}
