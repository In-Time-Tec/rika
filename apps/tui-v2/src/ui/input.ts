import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { Accessor } from "solid-js"
import type { Client, ThreadView } from "../client/model"
import { scenarios } from "../client/model"
import type { FocusPanel, Overlay, TranscriptNavigation } from "./types"
import { chord, printableSequence } from "./keys"

interface InputOptions {
  readonly client: Client
  readonly editor: Accessor<TextareaRenderable | undefined>
  readonly thread: Accessor<ThreadView | undefined>
  readonly overlay: Accessor<Overlay | undefined>
  readonly focus: Accessor<FocusPanel>
  readonly setFocus: (focus: FocusPanel) => void
  readonly draft: Accessor<string>
  readonly editing: Accessor<boolean>
  readonly cancelEdit: () => void
  readonly cancel: () => void
  readonly modal: (key: KeyEvent, overlay: Overlay) => void
  readonly commands: ReadonlyMap<string, () => void>
  readonly paste: (editor: TextareaRenderable) => void
  readonly showHelp: () => void
  readonly queue: (key: KeyEvent) => boolean
  readonly navigate: (action: TranscriptNavigation["action"]) => void
  readonly openFilePicker: () => void
}

const plain = (key: KeyEvent): boolean => !key.ctrl && key.option !== true && !key.meta

export function bindInput(options: InputOptions) {
  const globalKey = (key: KeyEvent): boolean => {
    if (key.ctrl && key.name === "c") {
      options.cancel()
      key.preventDefault()
      return true
    }
    const overlay = options.overlay()
    if (overlay !== undefined) {
      options.modal(key, overlay)
      return true
    }
    const editor = options.editor()
    if (key.ctrl && key.name === "v" && editor !== undefined) {
      options.paste(editor)
      key.preventDefault()
      return true
    }
    const command = options.commands.get(chord(key))
    if (command !== undefined) {
      command()
      key.preventDefault()
      return true
    }
    const scenario = key.ctrl ? scenarios[Number(key.name) - 1] : undefined
    if (scenario === undefined) return false
    options.client.loadScenario(scenario.id)
    key.preventDefault()
    return true
  }
  const approvalKey = (key: KeyEvent): boolean => {
    if (!plain(key) || key.shift || options.draft().length > 0 || options.thread()?.approval == null) return false
    const name = key.name.toLowerCase()
    if (name !== "a" && name !== "d") return false
    options.client.approve(name === "a")
    return true
  }
  const detailKey = (key: KeyEvent): boolean => {
    if (key.name === "tab" || key.name === "backtab") {
      options.setFocus("transcript")
      options.navigate(key.name === "backtab" || key.shift ? "previous" : "next")
      return true
    }
    if (options.focus() === "transcript" && (key.name === "return" || key.name === "enter") && !key.shift) {
      options.navigate("toggle")
      return true
    }
    if (key.sequence === "D" || (key.name.toLowerCase() === "d" && key.shift)) {
      options.navigate("all")
      return true
    }
    return false
  }
  const composerControl = (key: KeyEvent): boolean => {
    if (key.name === "escape" && options.editing()) {
      options.cancelEdit()
      options.setFocus("composer")
      return true
    }
    const input = options.draft()
    if (key.name === "?" && (options.focus() !== "composer" || input.length === 0)) {
      options.showHelp()
      return true
    }
    if (options.queue(key)) return true
    return input.trim().length === 0 && plain(key) && detailKey(key)
  }
  const typingKey = (key: KeyEvent): boolean => {
    const sequence = printableSequence(key),
      editor = options.editor()
    if (sequence === undefined || options.focus() === "composer" || editor === undefined) return false
    options.setFocus("composer")
    if (sequence === "@") options.openFilePicker()
    editor.insertText(sequence)
    return true
  }
  useKeyboard((key) => {
    if (key.eventType === "release" || key.defaultPrevented || globalKey(key)) return
    if (approvalKey(key) || composerControl(key) || typingKey(key)) key.preventDefault()
  })
}
