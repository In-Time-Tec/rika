import { Effect, Semaphore } from "effect"
import * as SynchronizedMap from "./synchronized-map"

export interface KeyedSemaphore<Key> {
  readonly semaphores: SynchronizedMap.SynchronizedMap<Key, Semaphore.Semaphore>
}

export const make = <Key>(): Effect.Effect<KeyedSemaphore<Key>> =>
  SynchronizedMap.make<Key, Semaphore.Semaphore>().pipe(Effect.map((semaphores) => ({ semaphores })))

export const withPermit = <Key, Value, Error, Requirements>(
  self: KeyedSemaphore<Key>,
  key: Key,
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> =>
  Effect.gen(function* () {
    const semaphore = yield* SynchronizedMap.getOrCreate(self.semaphores, key, () => Semaphore.make(1))
    return yield* Semaphore.withPermit(semaphore, effect)
  })

export const remove = <Key>(self: KeyedSemaphore<Key>, key: Key): Effect.Effect<void> =>
  SynchronizedMap.remove(self.semaphores, key)
