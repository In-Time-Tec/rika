import { Effect, HashMap, Option, Semaphore } from "effect"
import * as SynchronizedMap from "./synchronized-map"

interface Entry {
  readonly semaphore: Semaphore.Semaphore
  readonly inUse: number
  readonly removeWhenIdle: boolean
}

export interface KeyedSemaphore<Key> {
  readonly semaphores: SynchronizedMap.SynchronizedMap<Key, Entry>
}

export const make = <Key>(): Effect.Effect<KeyedSemaphore<Key>> =>
  SynchronizedMap.make<Key, Entry>().pipe(Effect.map((semaphores) => ({ semaphores })))

export const withPermit = <Key, Value, Error, Requirements>(
  self: KeyedSemaphore<Key>,
  key: Key,
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> =>
  Effect.acquireUseRelease(
    acquireEntry(self, key),
    (entry) => Semaphore.withPermit(entry.semaphore, effect),
    (entry) => releaseEntry(self, key, entry),
  )

export const remove = <Key>(self: KeyedSemaphore<Key>, key: Key): Effect.Effect<void> =>
  SynchronizedMap.modify(self.semaphores, (entries) => {
    const existing = HashMap.get(entries, key)
    if (Option.isNone(existing)) return [undefined, entries] as const
    if (existing.value.inUse === 0) return [undefined, HashMap.remove(entries, key)] as const
    return [undefined, HashMap.set(entries, key, { ...existing.value, removeWhenIdle: true })] as const
  })

const acquireEntry = <Key>(self: KeyedSemaphore<Key>, key: Key): Effect.Effect<Entry> =>
  SynchronizedMap.modifyEffect(self.semaphores, (entries) => {
    const existing = HashMap.get(entries, key)
    if (Option.isSome(existing)) {
      const entry = { ...existing.value, inUse: existing.value.inUse + 1 }
      return Effect.succeed([entry, HashMap.set(entries, key, entry)] as const)
    }
    return Semaphore.make(1).pipe(
      Effect.map((semaphore) => {
        const entry = { semaphore, inUse: 1, removeWhenIdle: false }
        return [entry, HashMap.set(entries, key, entry)] as const
      }),
    )
  })

const releaseEntry = <Key>(self: KeyedSemaphore<Key>, key: Key, acquired: Entry): Effect.Effect<void> =>
  SynchronizedMap.modify(self.semaphores, (entries) => {
    const existing = HashMap.get(entries, key)
    if (Option.isNone(existing) || existing.value.semaphore !== acquired.semaphore) return [undefined, entries] as const
    const inUse = existing.value.inUse <= 1 ? 0 : existing.value.inUse - 1
    if (inUse === 0 && existing.value.removeWhenIdle) return [undefined, HashMap.remove(entries, key)] as const
    return [undefined, HashMap.set(entries, key, { ...existing.value, inUse })] as const
  })
