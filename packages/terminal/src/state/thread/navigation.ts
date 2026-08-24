import { Function } from "effect"
import type { Model } from "../model"
import type { ThreadItem } from "./model"
import { readyOr } from "../loadable"

export const filteredFiles = (model: Model): ReadonlyArray<string> => {
  const items = readyOr(model.filePicker.items, [])
  const query = model.filePicker.query.toLowerCase()
  if (query.length === 0) {
    const segments = new Set<string>()
    for (const file of items) segments.add(file.split("/")[0]!)
    return [...segments].toSorted().slice(0, 50)
  }
  return items.filter((file) => file.toLowerCase().includes(query)).slice(0, 50)
}
export const filteredThreads = (model: Model): ReadonlyArray<ThreadItem> => {
  const query = model.threadSwitcher.query.toLowerCase()
  return (model.threads as ReadonlyArray<ThreadItem>).filter((thread) =>
    `${thread.title} ${thread.workspace ?? ""} ${thread.id}`.toLowerCase().includes(query),
  )
}
export const selectedThreadMetadata = (model: Model): ThreadItem | undefined =>
  filteredThreads(model)[model.threadSwitcher.selected]
const renameThreadImpl = (
  threads: ReadonlyArray<ThreadItem>,
  threadId: string,
  title: string,
): ReadonlyArray<ThreadItem> => threads.map((thread) => (thread.id === threadId ? { ...thread, title } : thread))

export const renameThread: {
  (
    arg1: Parameters<typeof renameThreadImpl>[1],
    arg2: Parameters<typeof renameThreadImpl>[2],
  ): (arg0: Parameters<typeof renameThreadImpl>[0]) => ReturnType<typeof renameThreadImpl>
  (
    arg0: Parameters<typeof renameThreadImpl>[0],
    arg1: Parameters<typeof renameThreadImpl>[1],
    arg2: Parameters<typeof renameThreadImpl>[2],
  ): ReturnType<typeof renameThreadImpl>
} = Function.dual(3, renameThreadImpl)
