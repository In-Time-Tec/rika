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
            exit: Deferred.await(exits[role]).pipe(Effect.map((exitCode) => ({ exitCode, errorOutput: "" }))),
            stop: Ref.update(stopped, (roles) => [...roles, role]),
          }),
        )
      const fiber = yield* superviseLocalRoles({
        headless: false,
        launch: { start },
      }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(exits["tui-controller"], 0)
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag === "Success" && exit.value).toEqual({ exitCode: 0, errorOutput: "" })
      expect(yield* Ref.get(started)).toEqual(["local-executor", "tui-controller"])
      expect(yield* Ref.get(stopped)).toEqual(["local-executor"])
    }),
  ),
)

it.effect("keeps the controller alive when the local executor is lost", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tuiExit = yield* Deferred.make<number>()
      const executorExit = yield* Deferred.make<number>()
      const start = (role: LocalRole) =>
        Effect.succeed<RoleProcess>({
          exit: Deferred.await(role === "tui-controller" ? tuiExit : executorExit).pipe(
            Effect.map((exitCode) => ({ exitCode, errorOutput: "" })),
          ),
          stop: Effect.void,
        })
      const fiber = yield* superviseLocalRoles({
        headless: false,
        launch: { start },
      }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(executorExit, 1)
      yield* Effect.yieldNow
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(tuiExit, 0)
      expect(yield* Fiber.join(fiber)).toEqual({ exitCode: 0, errorOutput: "" })
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
            Effect.as({ exit: Effect.succeed({ exitCode: 130, errorOutput: "" }), stop: Effect.void }),
          ),
      },
    })
    expect(exit).toEqual({ exitCode: 130, errorOutput: "" })
    expect(yield* Ref.get(started)).toEqual(["local-executor"])
  }),
)
