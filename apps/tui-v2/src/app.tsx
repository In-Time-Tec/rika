import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor, Setter } from "solid-js"
import { Effect } from "effect"
import type { Fiber } from "effect"
import { createCompletion } from "./ui/composer/completion"
import { chord, printableSequence } from "./ui/keys"
import { bindInput } from "./ui/input"
import { createDrafts } from "./ui/composer/drafts"
import { AppView } from "./ui/view"
import type { Client, Mode, ThreadView, TranscriptItem } from "./client/model"
import { createPalette } from "./ui/palette"
import { clipboardImage, workspaceFiles } from "./scenarios/fixtures"
import { contextSidebarWidth, isBusy } from "./ui/sidebars"
import { modeOrder } from "./ui/overlays"
import type { FocusPanel, DraftAttachment, Overlay, TranscriptNavigation } from "./ui/types"

export interface AppProps {
  readonly client: Client
  readonly onQuit: () => void
  readonly animate?: boolean
}

type SidebarKind = "workspace" | "changed"
type PendingEdit = {
  readonly threadId: string
  readonly id: string
  readonly originalDraft: string
  readonly originalAttachments: readonly DraftAttachment[]
}

const selectionKey = (
  key: KeyEvent,
  index: Accessor<number>,
  setIndex: Setter<number>,
  count: number,
  choose: () => void,
) => {
  if (key.name === "up" || key.name === "left") setIndex(Math.max(0, index() - 1))
  else if (key.name === "down" || key.name === "right") setIndex(Math.min(Math.max(0, count - 1), index() + 1))
  else if (key.name === "return" || key.name === "enter") choose()
  else return
  key.preventDefault()
}

const createController = (props: AppProps) => {
  const dimensions = useTerminalDimensions()
  const [focus, setFocus] = createSignal<FocusPanel>("composer")
  const [overlay, setOverlay] = createSignal<Overlay>()
  const [modeIndex, setModeIndex] = createSignal(0)
  const [editing, setEditing] = createSignal<PendingEdit>()
  const [pendingSelection, setPendingSelection] = createSignal<string>()
  const [sidebarKind, setSidebarKind] = createSignal<SidebarKind>()
  const [filePreview, setFilePreview] = createSignal<{ readonly path: string; readonly content: string }>()
  const [transcriptNavigation, setTranscriptNavigation] = createSignal<TranscriptNavigation>()
  const [forceExitArmed, setForceExitArmed] = createSignal(false)
  let forceExitTimer: Fiber.Fiber<void, never> | undefined
  let composerEditor: TextareaRenderable | undefined
  let navigationSerial = 0

  const selectedId = () => props.client.state.selectedThreadId
  const selectedThread = createMemo(() => props.client.state.threads.find((thread) => thread.id === selectedId()))
  const { drafts, setDrafts, draftAttachments, setAttachmentsFor, updateDraft, expandDraft, imagesFor, handlePaste } =
    createDrafts(selectedId, () => editing()?.id)
  const hasTranscript = () => (selectedThread()?.items.length ?? 0) > 0
  const narrow = () => dimensions().width < 60
  const contextual = createMemo(() => {
    const thread = selectedThread()
    return thread !== undefined && (thread.approval !== null || thread.items.some((item) => item.kind === "child"))
  })
  const changedItems = createMemo<readonly TranscriptItem[]>(
    () => selectedThread()?.items.filter((item) => item.kind === "diff") ?? [],
  )
  const allFilePaths = createMemo(() => {
    const paths = new Set<string>(workspaceFiles)
    for (const item of changedItems()) paths.add(item.title)
    return [...paths].toSorted((left, right) => left.localeCompare(right))
  })
  const {
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
  } = createCompletion({
    files: allFilePaths,
    threads: () => props.client.state.threads,
    selectedId,
    editor: () => composerEditor,
    show: (kind) => {
      setPaletteQuery("")
      setOverlay(kind)
    },
    close: () => closeOverlay(),
    selectThread: (id) => {
      props.client.selectThread(id)
      setPendingSelection(undefined)
    },
  })
  const fileSidebarWidth = () => Math.max(24, Math.min(52, Math.floor(dimensions().width * 0.4)))
  const contentWidth = createMemo(
    () =>
      dimensions().width -
      (!narrow() && contextual() ? contextSidebarWidth : 0) -
      (!narrow() && sidebarKind() !== undefined ? fileSidebarWidth() : 0),
  )

  const cancelEdit = () => {
    const current = editing()
    if (current === undefined) return
    setDrafts((previous) => ({ ...previous, [current.threadId]: current.originalDraft }))
    setAttachmentsFor(current.threadId, current.originalAttachments)
    setEditing(undefined)
  }
  const editPending = (id: string) => {
    const item = selectedThread()?.pending.find((pending) => pending.id === id)
    if (item === undefined) return
    cancelEdit()
    const threadId = selectedId()
    setEditing({
      threadId,
      id,
      originalDraft: drafts()[threadId] ?? "",
      originalAttachments: draftAttachments()[threadId] ?? [],
    })
    setDrafts((previous) => ({ ...previous, [threadId]: item.prompt }))
    setAttachmentsFor(threadId, [])
    setPendingSelection(id)
    setFocus("composer")
  }
  const submit = (input: string) => {
    const prompt = expandDraft(selectedId(), input)
    const current = editing()
    if (current !== undefined) {
      props.client.editPending(current.id, prompt)
      cancelEdit()
      return
    }
    props.client.submit(prompt, imagesFor(selectedId()))
    setDrafts((previous) => ({ ...previous, [selectedId()]: "" }))
    setAttachmentsFor(selectedId(), [])
  }
  const interruptAndSend = (input: string) => {
    const prompt = expandDraft(selectedId(), input)
    cancelEdit()
    props.client.interruptAndSend(prompt, imagesFor(selectedId()))
    setDrafts((previous) => ({ ...previous, [selectedId()]: "" }))
    setAttachmentsFor(selectedId(), [])
  }

  const insertBeforeCursor = (editor: TextareaRenderable, value: string) => editor.insertText(value)
  const closeOverlay = () => {
    setOverlay(undefined)
    setPicker(undefined)
    setPaletteQuery("")
    setPaletteIndex(0)
    setFilePreview(undefined)
    setFocus("composer")
  }
  const openPalette = () => {
    setPicker(undefined)
    setPaletteQuery("")
    setPaletteIndex(0)
    setOverlay("palette")
  }
  const openModePicker = () => {
    setPicker(undefined)
    setModeIndex(modeOrder.indexOf(props.client.state.mode))
    setOverlay("mode")
  }
  const chooseMode = (mode: Mode) => {
    props.client.setMode(mode)
    closeOverlay()
  }
  const newThread = (target: ThreadView["target"]) => {
    cancelEdit()
    setPendingSelection(undefined)
    props.client.newThread(target)
    setFocus("composer")
  }
  const archiveAndNew = () => {
    cancelEdit()
    props.client.archiveAndNewThread(() => {
      setPendingSelection(undefined)
      closeOverlay()
    })
  }
  const archiveAndQuit = () => props.client.archiveThread(props.onQuit)
  const openFile = (path: string) => {
    const diff = changedItems().find((item) => item.title === path)
    const content =
      diff?.text ??
      `Offline fixture: ${path}\n\nThis file is represented by the deterministic TUI fixture.\nWorkspace reads and process execution are disabled.`
    setFilePreview({ path, content })
    setOverlay("file-preview")
  }
  const toggleSidebar = (kind: SidebarKind) => {
    setSidebarKind((current) => (current === kind ? undefined : kind))
  }

  createEffect(() => {
    const current = editing()
    if (
      current !== undefined &&
      (current.threadId !== selectedId() || selectedThread()?.pending.some((item) => item.id === current.id) !== true)
    )
      cancelEdit()
  })
  createEffect(() => {
    const selected = pendingSelection()
    const pending = selectedThread()?.pending ?? []
    if (selected !== undefined && !pending.some((item) => item.id === selected)) setPendingSelection(undefined)
  })

  const focusOrder = createMemo<FocusPanel[]>(() => {
    const panels: FocusPanel[] = ["composer"]
    if (hasTranscript()) panels.push("transcript")
    if (!narrow() && contextual()) panels.push("context")
    return panels
  })
  createEffect(() => {
    if (!focusOrder().includes(focus())) setFocus("composer")
  })
  const navigateTranscript = (action: TranscriptNavigation["action"]) => {
    navigationSerial += 1
    setTranscriptNavigation({ serial: navigationSerial, action })
  }

  const pendingAction = (key: KeyEvent, id: string): boolean => {
    if (key.ctrl && key.name === "e") {
      editPending(id)
      return true
    }
    if (key.name === "return" && isBusy(selectedThread())) props.client.steerPending(id)
    else if (key.name === "backspace") props.client.removePending(id)
    else return false
    setPendingSelection(undefined)
    return true
  }
  const enterQueue = (key: KeyEvent): boolean => {
    if (key.name !== "up") return false
    setPendingSelection(selectedThread()?.pending.at(-1)?.id)
    return true
  }
  const queueKey = (key: KeyEvent): boolean => {
    const pending = selectedThread()?.pending ?? []
    const input = drafts()[selectedId()] ?? ""
    if (input.length > 0 || pending.length === 0 || editing() !== undefined) return false
    const current = pending.findIndex((item) => item.id === pendingSelection())
    if (current < 0) return enterQueue(key)
    if (key.name === "escape") {
      setPendingSelection(undefined)
      return true
    }
    if (key.name === "up") {
      setPendingSelection(pending[Math.max(0, current - 1)]?.id)
      return true
    }
    if (key.name === "down") {
      setPendingSelection(current === pending.length - 1 ? undefined : pending[current + 1]?.id)
      return true
    }
    const selected = pending[current]
    if (selected !== undefined) return pendingAction(key, selected.id)
    return false
  }

  const {
    paletteEntries,
    paletteQuery,
    setPaletteQuery,
    paletteIndex,
    setPaletteIndex,
    choosePalette,
    choosePaletteEntry,
  } = createPalette({
    isOpen: () => overlay() === "palette",
    client: props.client,
    selectedThread,
    newThread,
    openThreadSwitcher,
    openModePicker,
    setOverlay,
    toggleSidebar,
    editPending,
    closeOverlay,
  })
  const handleCtrlC = () => {
    if (forceExitArmed() || overlay() === "exit") {
      props.onQuit()
      return
    }
    if (!isBusy(selectedThread())) {
      setOverlay("exit")
      return
    }
    props.client.cancel()
    setForceExitArmed(true)
    forceExitTimer = Effect.runFork(
      Effect.delay(
        Effect.sync(() => {
          setForceExitArmed(false)
        }),
        1500,
      ),
    )
  }
  const commands = new Map<string, () => void>([
    ["C-o", openPalette],
    ["C-t", () => openThreadSwitcher()],
    ["A-w", () => openThreadSwitcher()],
    ["C-y", () => setOverlay("context")],
    ["A-t", () => toggleSidebar("workspace")],
    ["A-s", () => toggleSidebar("changed")],
    ["C-n", () => newThread("runner")],
    ["C-S-n", () => newThread("orb")],
    ["C-s", openModePicker],
    [
      "C-S-s",
      () =>
        props.client.setMode(modeOrder[(modeOrder.indexOf(props.client.state.mode) + 1) % modeOrder.length] ?? "high"),
    ],
  ])
  const toggle = new Map<Overlay, string>([
    ["palette", "C-o"],
    ["mode", "C-s"],
    ["context", "C-y"],
    ["shortcuts", "?"],
  ])
  const exitCommands = new Map<string, () => void>([
    ["C-n", archiveAndNew],
    ["C-e", archiveAndQuit],
    ["return", props.onQuit],
    ["enter", props.onQuit],
    ["y", props.onQuit],
  ])
  const modalKey = (key: KeyEvent, current: Overlay) => {
    if (current === "file-picker" || current === "threads") {
      if (pickerKey(key)) key.preventDefault()
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      closeOverlay()
      return
    }
    if (toggle.get(current) === chord(key)) {
      key.preventDefault()
      closeOverlay()
      return
    }
    if (current === "palette") selectionKey(key, paletteIndex, setPaletteIndex, paletteEntries().length, choosePalette)
    else if (current === "mode")
      selectionKey(key, modeIndex, setModeIndex, modeOrder.length, () =>
        chooseMode(modeOrder[modeIndex()] ?? props.client.state.mode),
      )
    else if (current === "exit") {
      exitCommands.get(chord(key))?.()
      key.preventDefault()
    }
  }
  bindInput({
    client: props.client,
    editor: () => composerEditor,
    thread: selectedThread,
    overlay,
    focus,
    setFocus,
    draft: () => drafts()[selectedId()] ?? "",
    editing: () => editing() !== undefined,
    cancelEdit,
    cancel: handleCtrlC,
    modal: modalKey,
    commands,
    paste: (editor) => handlePaste(clipboardImage, editor),
    showHelp: () => setOverlay("shortcuts"),
    queue: queueKey,
    navigate: navigateTranscript,
    openFilePicker,
  })
  onCleanup(() => {
    if (forceExitTimer !== undefined) forceExitTimer.interruptUnsafe()
  })
  return {
    hasTranscript,
    archiveAndNew,
    archiveAndQuit,
    setFocus,
    selectedThread,
    focus,
    overlay,
    transcriptNavigation,
    contentWidth,
    narrow,
    contextual,
    openPalette,
    editing,
    pendingSelection,
    setPendingSelection,
    editPending,
    selectedId,
    drafts,
    updateDraft,
    submit,
    interruptAndSend,
    handlePaste,
    sidebarKind,
    allFilePaths,
    changedItems,
    fileSidebarWidth,
    openFile,
    paletteEntries,
    paletteIndex,
    paletteQuery,
    setPaletteQuery,
    choosePaletteEntry,
    closeOverlay,
    threadEntries,
    threadPickerMode,
    threadPickerIndex,
    threadPickerQuery,
    updatePicker,
    chooseThread,
    modeIndex,
    chooseMode,
    fileEntries,
    filePickerIndex,
    chooseFile,
    filePreview,
    registerEditor: (editor: TextareaRenderable | undefined) => {
      composerEditor = editor
    },
    composerKey: (event: KeyEvent, editor: TextareaRenderable): boolean => {
      if (event.eventType === "release" || overlay() !== undefined) return false
      if (
        event.name === "return" &&
        !event.shift &&
        editor.cursorOffset > 0 &&
        editor.plainText[editor.cursorOffset - 1] === "\\"
      ) {
        editor.deleteCharBackward()
        editor.insertText("\n")
        return true
      }
      if (printableSequence(event) !== "@") return false
      openFilePicker()
      insertBeforeCursor(editor, "@")
      return true
    },
  }
}

export type AppViewState = ReturnType<typeof createController>

export function App(props: AppProps) {
  const state = createController(props)
  return <AppView {...props} state={state} />
}
