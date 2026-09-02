import { Clock, Effect, Exit, Fiber, Option } from "effect"
import { ghExecutable } from "../credential-broker"
import { WorkspaceError } from "../error"
import type { PreparationContext } from "./preparation-context"
import type { Options } from "./preparation-contracts"

export const runHook = Effect.fn("Workspace.hook")(function* (
  context: PreparationContext,
  name: "setup" | "resume",
  commitSha: string | null,
  timeout: number,
  blockingWindow?: number,
) {
  const { fileSystem, root, workspaceCommandPrefix, workspaceEnvironmentArguments, workspaceEnvironment } = context
  const phase = name
  yield* context.options.reporter.started(phase)
  const path = `${root}/.agents/${name}`
  const startedAt = yield* Clock.currentTimeMillis
  if (name === "setup") yield* fileSystem.remove(context.setupLog, { force: true })
  if (!(yield* fileSystem.exists(path)))
    return {
      digest: null,
      commitSha,
      buildDigest: context.buildDigest,
      environmentDigest: context.environmentDigest,
      startedAt,
      finishedAt: yield* Clock.currentTimeMillis,
      outcome: "missing" as const,
    }
  const info = yield* fileSystem
    .stat(path)
    .pipe(
      Effect.mapError(() =>
        WorkspaceError.make({ phase, message: `Could not inspect .agents/${name}`, retryable: true }),
      ),
    )
  if (info.type !== "File" || (info.mode & 0o111) === 0)
    return yield* WorkspaceError.make({
      phase,
      message: `.agents/${name} must be executable; run chmod +x .agents/${name} and retry explicitly`,
      retryable: true,
    })
  const digest = yield* fileSystem.readFile(path).pipe(
    Effect.flatMap(context.digestBytes),
    Effect.mapError(() => WorkspaceError.make({ phase, message: `Could not read .agents/${name}`, retryable: true })),
  )
  const command = context
    .command(
      [...workspaceCommandPrefix, "env", ...workspaceEnvironmentArguments, path],
      root,
      workspaceEnvironment,
      context.report(phase),
    )
    .pipe(
      Effect.timeoutOption(timeout),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(WorkspaceError.make({ phase, message: `.agents/${name} timed out`, retryable: true })),
          onSome: Effect.succeed,
        }),
      ),
    )
  const fiber = yield* Effect.forkScoped(command)
  const evidence = (outcome: "continued" | "completed" | "failed") =>
    Effect.map(Clock.currentTimeMillis, (finishedAt) => ({
      digest,
      commitSha,
      buildDigest: context.buildDigest,
      environmentDigest: context.environmentDigest,
      startedAt,
      finishedAt,
      outcome,
    }))
  // A hook that exits unsuccessfully leaves the workspace usable, like an Amp orb whose setup failed:
  // the outcome is recorded as evidence and its output stays in the preparation log for the user.
  const finished = (result: { readonly code: number }) =>
    result.code === 0
      ? evidence("completed")
      : Effect.logWarning("workspace.hook.failed").pipe(
          Effect.annotateLogs({ "rika.workspace.hook": name, "rika.workspace.hook.exit_code": result.code }),
          Effect.andThen(evidence("failed")),
        )
  if (blockingWindow !== undefined) {
    const early = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(blockingWindow))
    if (Option.isNone(early)) return yield* evidence("continued")
    return yield* finished(yield* Exit.match(early.value, { onFailure: Effect.failCause, onSuccess: Effect.succeed }))
  }
  const result = yield* Fiber.join(fiber)
  if (name === "setup")
    yield* fileSystem.writeFileString(context.setupLog, context.redact(result.output), { mode: 0o600 })
  return yield* finished(result)
})

export const inspectCapabilities = Effect.fn("Workspace.capabilities")(function* (
  context: PreparationContext,
  options: Options,
) {
  yield* options.reporter.started("capabilities")
  const required = context.assignment.checkout === null ? [["bun", "--version"]] : [["git", "--version"]]
  for (const command of required) {
    const result = yield* context.run("capabilities", command, 30_000)
    if (result.code !== 0)
      return yield* WorkspaceError.make({
        phase: "capabilities",
        message: `${command[0]} is unavailable`,
        retryable: false,
      })
  }
  if (context.assignment.checkout !== null) {
    const info = yield* context.fileSystem
      .stat(ghExecutable)
      .pipe(
        Effect.mapError(() =>
          WorkspaceError.make({ phase: "capabilities", message: "gh is unavailable", retryable: false }),
        ),
      )
    if (info.type !== "File" || (info.mode & 0o111) === 0)
      return yield* WorkspaceError.make({ phase: "capabilities", message: "gh is unavailable", retryable: false })
  }
  return context.assignment.checkout === null ? ["bun"] : ["git", "gh"]
})
