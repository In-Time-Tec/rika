import { Effect, Fiber, Schema, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type LocalRole = "tui-controller" | "local-executor"

export class LocalRoleProcessError extends Schema.TaggedError<LocalRoleProcessError>()("LocalRoleProcessError", {
  role: Schema.Literals(["tui-controller", "local-executor"]),
  message: Schema.String,
}) {}

export interface RoleProcess {
  readonly exitCode: Effect.Effect<number, LocalRoleProcessError>
  readonly stop: Effect.Effect<void>
}

export interface RoleLaunch {
  readonly start: (role: LocalRole) => Effect.Effect<RoleProcess, LocalRoleProcessError, Scope.Scope>
}

export interface RoleStatus {
  readonly localExecutorWaiting: Effect.Effect<void>
}

export interface RoleCommand {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly environment?: Readonly<Record<string, string>> | undefined
}

export const processRoleLaunch = Effect.fn("ClientMain.processRoleLaunch")(function* (
  commands: Readonly<Record<LocalRole, RoleCommand>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return {
    start: (role: LocalRole) =>
      spawner
        .spawn(
          ChildProcess.make(commands[role].executable, commands[role].arguments, {
            stdin: role === "tui-controller" ? "inherit" : "ignore",
            stdout: "inherit",
            stderr: "inherit",
            extendEnv: true,
            env: commands[role].environment,
          }),
        )
        .pipe(
          Effect.map((handle) => ({
            exitCode: handle.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(() => LocalRoleProcessError.make({ role, message: `${role} process failed` })),
            ),
            stop: handle.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(Effect.ignore),
          })),
          Effect.mapError(() => LocalRoleProcessError.make({ role, message: `${role} process could not start` })),
        ),
  } satisfies RoleLaunch
})

export const superviseLocalRoles = Effect.fn("ClientMain.superviseLocalRoles")(function* (input: {
  readonly headless: boolean
  readonly launch: RoleLaunch
  readonly status: RoleStatus
}) {
  const executor = yield* input.launch.start("local-executor")
  if (input.headless) return yield* executor.exitCode
  const tui = yield* input.launch.start("tui-controller").pipe(Effect.onError(() => executor.stop))
  const executorExit = yield* executor.exitCode.pipe(
    Effect.andThen(input.status.localExecutorWaiting),
    Effect.forkScoped,
  )
  return yield* tui.exitCode.pipe(Effect.ensuring(Fiber.interrupt(executorExit).pipe(Effect.andThen(executor.stop))))
})
