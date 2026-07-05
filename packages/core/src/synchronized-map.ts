import { Effect, HashMap, Option, SynchronizedRef } from "effect"

export interface SynchronizedMap<Key, Value> {
  readonly ref: SynchronizedRef.SynchronizedRef<HashMap.HashMap<Key, Value>>
}

export const make = <Key, Value>(): Effect.Effect<SynchronizedMap<Key, Value>> =>
  SynchronizedRef.make(HashMap.empty<Key, Value>()).pipe(Effect.map((ref) => ({ ref })))

export const get = <Key, Value>(self: SynchronizedMap<Key, Value>, key: Key): Effect.Effect<Option.Option<Value>> =>
  SynchronizedRef.get(self.ref).pipe(Effect.map((entries) => HashMap.get(entries, key)))

export const getOrCreate = <Key, Value, Error, Requirements>(
  self: SynchronizedMap<Key, Value>,
  key: Key,
  create: () => Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> =>
  SynchronizedRef.modifyEffect(self.ref, (entries) => {
    const existing = HashMap.get(entries, key)
    if (Option.isSome(existing)) return Effect.succeed([existing.value, entries] as const)
    return create().pipe(Effect.map((value) => [value, HashMap.set(entries, key, value)] as const))
  })

export const set = <Key, Value>(self: SynchronizedMap<Key, Value>, key: Key, value: Value): Effect.Effect<void> =>
  SynchronizedRef.update(self.ref, (entries) => HashMap.set(entries, key, value))

export const remove = <Key, Value>(self: SynchronizedMap<Key, Value>, key: Key): Effect.Effect<void> =>
  SynchronizedRef.update(self.ref, (entries) => HashMap.remove(entries, key))

export const modify = <Key, Value, Result>(
  self: SynchronizedMap<Key, Value>,
  f: (entries: HashMap.HashMap<Key, Value>) => readonly [Result, HashMap.HashMap<Key, Value>],
): Effect.Effect<Result> => SynchronizedRef.modify(self.ref, f)

export const modifyEffect = <Key, Value, Result, Error, Requirements>(
  self: SynchronizedMap<Key, Value>,
  f: (
    entries: HashMap.HashMap<Key, Value>,
  ) => Effect.Effect<readonly [Result, HashMap.HashMap<Key, Value>], Error, Requirements>,
): Effect.Effect<Result, Error, Requirements> => SynchronizedRef.modifyEffect(self.ref, f)
