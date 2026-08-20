import { Effect, Option, Queue } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

type Frame = string | Socket.CloseEvent

const expressCapacity = 64

export const makeOutbound = <E>(options: {
  readonly capacity: number
  readonly rawWriter: (frame: Frame) => Effect.Effect<void, E>
}): Effect.Effect<{
  readonly write: (frame: Frame) => Effect.Effect<void>
  readonly writeExpress: (frame: Frame) => Effect.Effect<void>
  readonly run: Effect.Effect<never, E>
}> =>
  Effect.gen(function* () {
    const stream = yield* Queue.bounded<Frame>(options.capacity)
    const express = yield* Queue.bounded<Frame>(expressCapacity)
    const ready = yield* Queue.bounded<void>(options.capacity + expressCapacity)
    const offer = (queue: Queue.Queue<Frame>, frame: Frame) =>
      Queue.offer(queue, frame).pipe(Effect.andThen(Queue.offer(ready, undefined)), Effect.asVoid)
    const take = Effect.gen(function* () {
      yield* Queue.take(ready)
      const priority = yield* Queue.poll(express)
      if (Option.isSome(priority)) return priority.value
      return yield* Queue.take(stream)
    })
    return {
      write: (frame: Frame) => offer(stream, frame),
      writeExpress: (frame: Frame) => offer(express, frame),
      run: Effect.forever(take.pipe(Effect.flatMap(options.rawWriter))),
    }
  })
