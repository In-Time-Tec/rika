import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { composerEdit } from "@rika/terminal/terminal-composer-edit"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import type { ThreadView } from "../../client/model"
import { printableSequence } from "../keys"

export type Picker =
  | { readonly kind: "file"; readonly query: string; readonly index: number }
  | { readonly kind: "thread"; readonly mode: "switch" | "mention"; readonly query: string; readonly index: number }
interface CompletionOptions {
  readonly files: Accessor<readonly string[]>
  readonly threads: Accessor<readonly ThreadView[]>
  readonly selectedId: Accessor<string>
  readonly editor: Accessor<TextareaRenderable | undefined>
  readonly show: (kind: "threads" | "file-picker") => void
  readonly close: () => void
  readonly selectThread: (id: string) => void
}

export function createCompletion(options: CompletionOptions) {
  const [picker, setPicker] = createSignal<Picker>()
  const fileEntries = createMemo(() => {
    const current = picker()
    const query = current?.kind === "file" ? current.query.toLowerCase() : ""
    if (query.length === 0)
      return [...new Set(options.files().map((path) => path.split("/")[0] ?? path))].toSorted().slice(0, 50)
    return options
      .files()
      .filter((path) => path.toLowerCase().includes(query))
      .slice(0, 50)
  })
  const threadEntries = createMemo(() => {
    const current = picker()
    const query = current?.kind === "thread" ? current.query.toLowerCase() : ""
    return options
      .threads()
      .filter((thread) => `${thread.title} ${thread.id} ${thread.target}`.toLowerCase().includes(query))
  })
  const updatePicker = (update: (current: Picker) => Picker) =>
    setPicker((current) => (current === undefined ? undefined : update(current)))
  const insert = (value: string) => options.editor()?.insertText(value)
  const erase = (count: number) => {
    const editor = options.editor()
    if (editor === undefined) return
    for (let index = 0; index < count; index += 1) if (!editor.deleteCharBackward()) break
  }
  const openFilePicker = () => {
    setPicker({ kind: "file", query: "", index: 0 })
    options.show("file-picker")
  }
  const openThreadSwitcher = (mode: "switch" | "mention" = "switch") => {
    const index =
      mode === "switch"
        ? Math.max(
            0,
            options.threads().findIndex((thread) => thread.id === options.selectedId()),
          )
        : 0
    setPicker({ kind: "thread", mode, query: "", index })
    options.show("threads")
  }
  const chooseFile = (entry: string | undefined) => {
    const current = picker()
    if (current?.kind === "file" && entry !== undefined && options.editor() !== undefined) {
      erase(1 + Array.from(current.query).length)
      insert(composerEdit.fileMention(entry))
    }
    options.close()
  }
  const chooseThread = (thread: ThreadView | undefined) => {
    const current = picker()
    if (current?.kind !== "thread" || thread === undefined) return
    if (current.mode === "mention") {
      erase(2 + Array.from(current.query).length)
      insert(composerEdit.fileMention(thread.id))
    } else options.selectThread(thread.id)
    options.close()
  }
  const move = (direction: number) => {
    const current = picker()
    if (current === undefined) return
    const count = Math.max(1, current.kind === "file" ? fileEntries().length : threadEntries().length)
    setPicker({ ...current, index: (current.index + direction + count) % count })
  }
  const fileBackspace = (current: Extract<Picker, { kind: "file" }>) => {
    erase(1)
    if (current.query.length === 0) options.close()
    else setPicker({ ...current, query: Array.from(current.query).slice(0, -1).join(""), index: 0 })
  }
  const threadBackspace = (current: Extract<Picker, { kind: "thread" }>) => {
    if (current.mode === "mention") erase(1)
    if (current.query.length > 0) {
      setPicker({ ...current, query: Array.from(current.query).slice(0, -1).join(""), index: 0 })
    } else if (current.mode === "mention") openFilePicker()
    else options.close()
  }
  const fileKey = (key: KeyEvent, current: Extract<Picker, { kind: "file" }>): boolean => {
    if (key.name === "backspace") {
      fileBackspace(current)
      return true
    }
    const sequence = printableSequence(key)
    if (sequence === undefined) return false
    insert(sequence)
    if (sequence === "@" && current.query.length === 0) openThreadSwitcher("mention")
    else setPicker({ ...current, query: current.query + sequence, index: 0 })
    return true
  }
  const threadKey = (key: KeyEvent, current: Extract<Picker, { kind: "thread" }>): boolean => {
    if (key.name === "backspace") {
      threadBackspace(current)
      return true
    }
    const sequence = printableSequence(key)
    if (sequence === undefined) return false
    if (current.mode === "mention") insert(sequence)
    setPicker({ ...current, query: current.query + sequence, index: 0 })
    return true
  }
  const pickerKey = (key: KeyEvent): boolean => {
    const current = picker()
    if (current === undefined) return false
    if (key.name === "escape") {
      options.close()
      return true
    }
    if (key.name === "up") {
      move(-1)
      return true
    }
    if (key.name === "down") {
      move(1)
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      if (current.kind === "file") chooseFile(fileEntries()[current.index])
      else chooseThread(threadEntries()[current.index])
      return true
    }
    return current.kind === "file" ? fileKey(key, current) : threadKey(key, current)
  }
  createEffect(() => {
    const current = picker()
    if (current === undefined) return
    const count = current.kind === "file" ? fileEntries().length : threadEntries().length
    if (current.index >= Math.max(1, count)) setPicker({ ...current, index: 0 })
  })
  const filePickerIndex = () => {
    const current = picker()
    return current?.kind === "file" ? current.index : 0
  }
  const threadPickerMode = () => {
    const current = picker()
    return current?.kind === "thread" ? current.mode : "switch"
  }
  const threadPickerIndex = () => {
    const current = picker()
    return current?.kind === "thread" ? current.index : 0
  }
  const threadPickerQuery = () => {
    const current = picker()
    return current?.kind === "thread" ? current.query : ""
  }
  return {
    picker,
    setPicker,
    updatePicker,
    fileEntries,
    threadEntries,
    openFilePicker,
    openThreadSwitcher,
    chooseFile,
    chooseThread,
    pickerKey,
    filePickerIndex,
    threadPickerMode,
    threadPickerIndex,
    threadPickerQuery,
  }
}
