import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Context, Effect, Layer, Option, Schema, Stream, type Duration } from "effect"

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
  readonly resumeTimeout?: Duration.Input
}

const defaultResumeTimeout: Duration.Input = "10 seconds"

export const layerWithOptions = (options: LayerOptions = {}) =>
  Layer.succeed(Service, makeService(options.resumeTimeout ?? defaultResumeTimeout))

export const layer = layerWithOptions()

export const runSetup = (workspaceRoot: string) =>
  Stream.unwrap(Effect.map(Service, (service) => service.runSetup(workspaceRoot)))

export const runResume = Effect.fn("LifecycleHooks.runResume.call")(function* (workspaceRoot: string) {
  const service = yield* Service
  return yield* service.runResume(workspaceRoot)
})

function makeService(resumeTimeout: Duration.Input): Interface {
  return Service.of({
    runSetup: (workspaceRoot) => {
      const root = resolve(workspaceRoot)
      return Stream.unwrap(
        preflight("setup", root).pipe(
          Effect.map((hook) => (hook.status === "missing" ? Stream.empty : streamSetup(root, hook.path))),
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

const streamSetup = (workspaceRoot: string, path: string): Stream.Stream<HookOutputLine, HookError> =>
  Stream.unwrap(
    spawnSetup(workspaceRoot, path).pipe(
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

const spawnSetup = (workspaceRoot: string, path: string) =>
  Effect.try({
    try: () =>
      Bun.spawn([path], {
        cwd: workspaceRoot,
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: (cause) =>
      new HookError({
        hook: "setup",
        path,
        workspaceRoot,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

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
