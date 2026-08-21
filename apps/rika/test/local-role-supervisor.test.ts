import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { superviseLocalRoles, type LocalRole, type RoleProcess } from "../src/client/local-role-supervisor"

it.effect("runs sibling controller and executor roles and stops only the executor when the controller exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<LocalRole>>([])
      const stopped = yield* Ref.make<ReadonlyArray<LocalRole>>([])
      const exits = {
        "tui-controller": yield* Deferred.make<number>(),
        "local-executor": yield* Deferred.make<number>(),
      }
      const start = (role: LocalRole) =>
        Ref.update(started, (roles) => [...roles, role]).pipe(
          Effect.as<RoleProcess>({
            exitCode: Deferred.await(exits[role]),
            stop: Ref.update(stopped, (roles) => [...roles, role]),
          }),
        )
      const fiber = yield* superviseLocalRoles({
        headless: false,
        launch: { start },
        status: { localExecutorWaiting: Effect.void },
      }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(exits["tui-controller"], 0)
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag === "Success" && exit.value).toBe(0)
      expect(yield* Ref.get(started)).toEqual(["local-executor", "tui-controller"])
      expect(yield* Ref.get(stopped)).toEqual(["local-executor"])
    }),
  ),
)

it.effect("keeps the controller alive and reports waiting when the local executor is lost", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>()
      const tuiExit = yield* Deferred.make<number>()
      const executorExit = yield* Deferred.make<number>()
      const start = (role: LocalRole) =>
        Effect.succeed<RoleProcess>({
          exitCode: Deferred.await(role === "tui-controller" ? tuiExit : executorExit),
          stop: Effect.void,
        })
      const fiber = yield* superviseLocalRoles({
        headless: false,
        launch: { start },
        status: { localExecutorWaiting: Deferred.succeed(waiting, undefined) },
      }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(executorExit, 1)
      yield* Deferred.await(waiting)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(tuiExit, 0)
      expect(yield* Fiber.join(fiber)).toBe(0)
    }),
  ),
)

it.effect("headless mode starts only the executor", () =>
  Effect.gen(function* () {
    const started = yield* Ref.make<ReadonlyArray<LocalRole>>([])
    const exit = yield* superviseLocalRoles({
      headless: true,
      launch: {
        start: (role) =>
          Ref.update(started, (roles) => [...roles, role]).pipe(
            Effect.as({ exitCode: Effect.succeed(130), stop: Effect.void }),
          ),
      },
      status: { localExecutorWaiting: Effect.void },
    })
    expect(exit).toBe(130)
    expect(yield* Ref.get(started)).toEqual(["local-executor"])
  }),
)
