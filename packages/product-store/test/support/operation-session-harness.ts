import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { Input } from "@rika/product/product-operation"
import { Service } from "@rika/product/product-operation-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import { Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import * as ResolvedContext from "@rika/product/context-resolution-service"

export const collectEvents = (session: InteractiveSession, events: Array<InteractiveEvent>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(session.events((event) => events.push(event)))
    yield* Effect.yieldNow
    return fiber
  })

export const holdSession =
  (sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>) =>
  (_: Input & { readonly _tag: "Interactive" }, session: InteractiveSession) =>
    Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never))

export const openInteractiveSession = Effect.fn("OperationTest.openInteractiveSession")(function* (
  sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>,
  input: Input & { readonly _tag: "Interactive" },
) {
  const operation = yield* Service
  const previousCount = (yield* Ref.get(sessions)).length
  yield* Effect.forkChild(operation.run(input))
  while ((yield* Ref.get(sessions)).length <= previousCount) yield* Effect.yieldNow
  const session = (yield* Ref.get(sessions)).at(-1)
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return session
})

export const settleEvents = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

export const settleUsage = settleEvents.pipe(Effect.andThen(TestClock.adjust("1 second")), Effect.andThen(settleEvents))

export const nonActivation = (list: ReadonlyArray<InteractiveEvent>): Array<InteractiveEvent> =>
  list.filter((event) => event._tag !== "ThreadActivated")

export const reconcileDependencies = (extensions: ExecutionExtensions.ExecutionExtensionInterface) =>
  Layer.merge(
    ResolvedContext.testLayer({ resolve: () => Effect.die("unused") }),
    Layer.succeed(ExecutionExtensions.ExecutionExtensionService, extensions),
  )

export const unusedExtensions = ExecutionExtensions.ExecutionExtensionService.of({
  future: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
})
