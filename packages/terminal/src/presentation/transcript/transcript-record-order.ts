import { Function } from "effect"

export interface OrderedRecord<T> {
  readonly key: string
  readonly renderable: T
}

const mergePinnedRecordsImpl = <T, R extends OrderedRecord<T>>(
  desired: ReadonlyArray<R>,
  pinned: ReadonlyArray<R>,
  previousOrder: ReadonlyMap<T, number>,
): ReadonlyArray<R> => {
  const positionOf = (record: R) => previousOrder.get(record.renderable) ?? -1
  const records = [...desired]
  for (const record of pinned) {
    const previous = positionOf(record)
    const insertion = records.findIndex((candidate) => positionOf(candidate) > previous)
    records.splice(insertion === -1 ? records.length : insertion, 0, record)
  }
  return records
}

export const mergePinnedRecords: {
  <T, R extends OrderedRecord<T>>(
    desired: ReadonlyArray<R>,
    pinned: ReadonlyArray<R>,
    previousOrder: ReadonlyMap<T, number>,
  ): ReadonlyArray<R>
  <T, R extends OrderedRecord<T>>(
    pinned: ReadonlyArray<R>,
    previousOrder: ReadonlyMap<T, number>,
  ): (desired: ReadonlyArray<R>) => ReadonlyArray<R>
} = Function.dual(3, mergePinnedRecordsImpl)
