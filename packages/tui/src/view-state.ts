import { Function, Schema } from "effect"
import type { Key } from "./keys"
import { isPrintable } from "./keys"
import { filter, type PaletteAction } from "./palette"
import { expandableUnits, transcriptUnitId, unitToggleTargets } from "./transcript-units"

export const Mode = Schema.Literals(["low", "medium", "high", "ultra"])
export const ReasoningEffort = Schema.Literals(["low", "medium", "high", "xhigh"])
export type ReasoningEffort = typeof ReasoningEffort.Type
export type Mode = typeof Mode.Type

export const Entry = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "notice"]),
  text: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
})
export type Entry = typeof Entry.Type

export type TranscriptBlock =
  | { readonly _tag: "Reasoning"; readonly text: string; readonly expanded: boolean }
  | {
      readonly _tag: "ToolCall"
      readonly id: string
      readonly name: string
      readonly input: string
      readonly status: "running" | "complete" | "failed"
      readonly output?: string
      readonly expanded?: boolean
    }
  | { readonly _tag: "ToolResult"; readonly id: string; readonly output: string; readonly failed: boolean }
  | { readonly _tag: "Diff"; readonly path: string; readonly patch: string; readonly expanded?: boolean }
  | { readonly _tag: "ContextUsage"; readonly text: string; readonly cost?: string }
  | { readonly _tag: "Compaction"; readonly summary: string; readonly checkpoint?: string }
  | { readonly _tag: "Notification"; readonly title: string; readonly detail: string }
  | {
      readonly _tag: "Error"
      readonly title: string
      readonly detail: string
      readonly turnId?: string
      readonly recovery?: string
    }
  | {
      readonly _tag: "Permission"
      readonly id: string
      readonly kind: "permission" | "tool-approval"
      readonly title: string
      readonly detail: string
      readonly status: "pending" | "approved" | "denied"
    }
  | { readonly _tag: "Queued"; readonly id: string; readonly prompt: string }
  | {
      readonly _tag: "ChildAgent"
      readonly name: string
      readonly summary: string
      readonly status: "running" | "complete" | "failed"
    }
  | {
      readonly _tag: "Workflow"
      readonly name: string
      readonly step: string
      readonly status: "running" | "waiting" | "complete" | "failed"
    }
  | {
      readonly _tag: "ImageAttachment"
      readonly name: string
      readonly mediaType: string
      readonly width?: number
      readonly height?: number
      readonly bytes?: number
    }

export interface ThreadItem {
  readonly id: string
  readonly title: string
  readonly active: boolean
  readonly unread: boolean
  readonly workspace?: string
  readonly archived?: boolean
  readonly updatedAt?: number
  readonly diff?: string
}

export type PermissionDecision = "allow" | "always" | "deny"
export type PromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly path: string }
export type ComposerAttachment =
  | {
      readonly type: "text"
      readonly token: string
      readonly value: string
      readonly label: string
    }
  | {
      readonly type: "image"
      readonly token: string
      readonly path: string
      readonly label: string
    }
export interface ComposerDraft {
  readonly input: string
  readonly attachments: ReadonlyArray<ComposerAttachment>
}
export interface PastedTextAttachment {
  readonly type: "text" | "image"
  readonly token: string
  readonly value?: string
  readonly path?: string
  readonly label: string
}
export type UiEvent = {
  readonly id: string
  readonly cursor: string
  readonly turnId?: string
  readonly block: TranscriptBlock
}
export type TranscriptItem =
  | { readonly _tag: "Entry"; readonly index: number; readonly turnId?: string }
  | { readonly _tag: "Block"; readonly index: number; readonly turnId?: string }

export interface PaletteState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
}
export interface ModePickerState {
  readonly open: boolean
  readonly selected: number
}
export interface FilePickerState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
  readonly items: Loadable<ReadonlyArray<string>>
  readonly kind: "file" | "thread"
}
export interface ThreadSwitcherState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
}

export type Loadable<T> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: T }

const LoadableIdleSchema = Schema.TaggedStruct("Idle", {})
const LoadableLoadingSchema = Schema.TaggedStruct("Loading", {})

export const idle: Loadable<never> = { _tag: "Idle" }
export const loading: Loadable<never> = { _tag: "Loading" }
export const ready = <T>(value: T): Loadable<T> => ({ _tag: "Ready", value })
export const readyOr: {
  <T>(loadable: Loadable<T>, fallback: T): T
  <T>(fallback: T): (loadable: Loadable<T>) => T
} = Function.dual(
  2,
  <T>(loadable: Loadable<T>, fallback: T): T => (loadable._tag === "Ready" ? loadable.value : fallback),
)
export const isReady = <T>(loadable: Loadable<T>): loadable is { readonly _tag: "Ready"; readonly value: T } =>
  loadable._tag === "Ready"
export const isLoading = <T>(loadable: Loadable<T>): boolean => loadable._tag === "Loading"

const WorkspaceFilesSchema = Schema.Union([
  LoadableIdleSchema,
  LoadableLoadingSchema,
  Schema.TaggedStruct("Ready", { value: Schema.Array(Schema.String) }),
])

const PaletteStateSchema = Schema.Struct({ open: Schema.Boolean, query: Schema.String, selected: Schema.Finite })
const ModePickerStateSchema = Schema.Struct({ open: Schema.Boolean, selected: Schema.Finite })
const FilePickerStateSchema = Schema.Struct({
  open: Schema.Boolean,
  query: Schema.String,
  selected: Schema.Finite,
  items: WorkspaceFilesSchema,
  kind: Schema.Literals(["file", "thread"]),
})
const ThreadSwitcherStateSchema = Schema.Struct({ open: Schema.Boolean, query: Schema.String, selected: Schema.Finite })
const PastedTextAttachmentSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), token: Schema.String, value: Schema.String, label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), token: Schema.String, path: Schema.String, label: Schema.String }),
])
const ComposerDraftSchema = Schema.Struct({
  input: Schema.String,
  attachments: Schema.Array(PastedTextAttachmentSchema),
})

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.optional(Schema.Finite),
  removed: Schema.optional(Schema.Finite),
})
export type ChangedFile = typeof ChangedFile.Type

const ChangedFilesSchema = Schema.Union([
  LoadableIdleSchema,
  LoadableLoadingSchema,
  Schema.TaggedStruct("Ready", { value: Schema.Array(ChangedFile) }),
])
const ThreadPreviewSchema = Schema.Union([
  LoadableIdleSchema,
  LoadableLoadingSchema,
  Schema.TaggedStruct("Ready", {
    value: Schema.Struct({
      threadId: Schema.String,
      turns: Schema.Array(Schema.Struct({ prompt: Schema.String, events: Schema.Array(Schema.Unknown) })),
    }),
  }),
])

export const Model = Schema.Struct({
  workspace: Schema.String,
  branch: Schema.optional(Schema.String),
  mode: Mode,
  entries: Schema.Array(Entry),
  blocks: Schema.Array(Schema.Unknown),
  items: Schema.Array(Schema.Unknown),
  input: Schema.String,
  cursor: Schema.Finite,
  pastedText: Schema.Array(PastedTextAttachmentSchema),
  history: Schema.Array(Schema.String),
  historyComposers: Schema.Array(ComposerDraftSchema),
  historyDraft: Schema.optional(ComposerDraftSchema),
  historyIndex: Schema.optional(Schema.Finite),
  historySearch: Schema.String,
  busy: Schema.Boolean,
  busyStatus: Schema.optional(Schema.String),
  costUsd: Schema.optional(Schema.Finite),
  paletteOpen: Schema.Boolean,
  palette: PaletteStateSchema,
  modePicker: ModePickerStateSchema,
  filePicker: FilePickerStateSchema,
  threadSwitcher: ThreadSwitcherStateSchema,
  shortcutsOpen: Schema.Boolean,
  pendingAction: Schema.optional(Schema.Unknown),
  composerHeight: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  scrollOffset: Schema.Finite,
  scrollFollow: Schema.Boolean,
  threads: Schema.Array(Schema.Unknown),
  sidebarOpen: Schema.Boolean,
  selectedThread: Schema.Finite,
  permissionSelection: Schema.Finite,
  queueSelection: Schema.optional(Schema.String),
  queue: Schema.Array(Schema.Unknown),
  detailSelection: Schema.optional(Schema.String),
  seenEventIds: Schema.Array(Schema.String),
  seenExecutionEventKeys: Schema.Array(Schema.String),
  activeTurnId: Schema.optional(Schema.String),
  eventCursor: Schema.optional(Schema.String),
  currentThreadId: Schema.optional(Schema.String),
  currentThreadTitle: Schema.optional(Schema.String),
  fastMode: Schema.Boolean,
  reasoningEffort: ReasoningEffort,
  changedFilesOpen: Schema.Boolean,
  changedFiles: ChangedFilesSchema,
  sidebarWidth: Schema.Finite,
  threadLoading: Schema.Boolean,
  toolCallDrafts: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String), text: Schema.String }),
  ),
  threadPreview: ThreadPreviewSchema,
})
export type Model = typeof Model.Type

export type Message =
  | { readonly _tag: "KeyPressed"; readonly key: Key }
  | { readonly _tag: "Pasted"; readonly text: string }
  | { readonly _tag: "ImageInserted"; readonly path: string }
  | { readonly _tag: "ImageRemoved"; readonly path: string }
  | { readonly _tag: "PastedTextExpanded"; readonly token: string }
  | { readonly _tag: "Resized"; readonly width: number; readonly height: number }
  | { readonly _tag: "ComposerHeightChanged"; readonly height: number }
  | { readonly _tag: "Submitted" }
  | { readonly _tag: "TurnStarted"; readonly turnId: string; readonly prompt: string }
  | { readonly _tag: "AssistantStreamed"; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "AssistantCompleted"; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "ExecutionCompleted"; readonly turnId?: string }
  | { readonly _tag: "ExecutionFailed"; readonly turnId?: string; readonly message: string }
  | { readonly _tag: "ExecutionCancelled"; readonly turnId?: string }
  | { readonly _tag: "SubmissionQueued"; readonly prompt: string }
  | { readonly _tag: "BlockAdded"; readonly block: TranscriptBlock }
  | { readonly _tag: "ReasoningStreamed"; readonly text: string }
  | { readonly _tag: "ReasoningToggled"; readonly index: number }
  | { readonly _tag: "QueuedEdited"; readonly index: number; readonly prompt: string }
  | { readonly _tag: "QueuedDequeued"; readonly index: number }
  | { readonly _tag: "ScrollMoved"; readonly offset: number }
  | { readonly _tag: "ScrollFollowed" }
  | { readonly _tag: "PaletteActionConsumed" }
  | { readonly _tag: "ThreadsReplaced"; readonly threads: ReadonlyArray<ThreadItem> }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "ThreadTitleChanged"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "FilesReplaced"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "BranchDetected"; readonly branch: string }
  | { readonly _tag: "UsageReported"; readonly costUsd?: number }
  | { readonly _tag: "SidebarToggled" }
  | { readonly _tag: "ThreadSelectionMoved"; readonly offset: number }
  | { readonly _tag: "ThreadSelectionConfirmed" }
  | { readonly _tag: "PermissionSelectionMoved"; readonly offset: number }
  | { readonly _tag: "PermissionDecisionSelected"; readonly id: string; readonly decision?: PermissionDecision }
  | { readonly _tag: "EventReplayed"; readonly event: UiEvent }
  | { readonly _tag: "DetailMoved"; readonly offset: number }
  | { readonly _tag: "DetailToggled"; readonly id?: string }
  | { readonly _tag: "FastModeToggled" }
  | { readonly _tag: "ReasoningEffortCycled" }
  | { readonly _tag: "SidebarViewToggled" }
  | { readonly _tag: "SidebarWidthChanged"; readonly width: number }
  | { readonly _tag: "ComposerReplaced"; readonly text: string }
  | { readonly _tag: "ChangedFilesRequested" }
  | { readonly _tag: "ChangedFilesReplaced"; readonly files: ReadonlyArray<ChangedFile> }
  | { readonly _tag: "FilesRequested" }
  | { readonly _tag: "ThreadPreviewRequested" }
  | { readonly _tag: "ThreadOpenRequested" }
  | { readonly _tag: "ThreadOpenCompleted" }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly events: ReadonlyArray<unknown> }>
    }
  | { readonly _tag: "ToolCallDeltaReceived"; readonly id: string; readonly name?: string; readonly delta: string }

export interface QueueItem {
  readonly id: string
  readonly prompt: string
  readonly attachments?: ReadonlyArray<string>
}

export const replaceQueue: {
  (model: Model, queue: ReadonlyArray<QueueItem>): Model
  (queue: ReadonlyArray<QueueItem>): (model: Model) => Model
} = Function.dual(2, (model: Model, queue: ReadonlyArray<QueueItem>): Model => {
  const selected = queue.some((item) => item.id === model.queueSelection) ? model.queueSelection : undefined
  return {
    ...model,
    queue: [...queue],
    queueSelection: selected,
  }
})

export const defaultReasoningEffort = (mode: Mode): ReasoningEffort =>
  mode === "low" ? "low" : mode === "medium" ? "medium" : "high"

const clampSidebarWidth = (width: number, terminalWidth: number): number =>
  Math.max(24, Math.min(width, Math.max(24, terminalWidth - 40)))

export const initial: {
  (workspace: string, mode?: Mode): Model
  (mode?: Mode): (workspace: string) => Model
} = Function.dual(
  (args) => args.length > 1 || !Mode.literals.includes(args[0]),
  (workspace: string, mode: Mode = "medium"): Model => ({
    workspace,
    mode,
    entries: [],
    blocks: [],
    items: [],
    input: "",
    cursor: 0,
    pastedText: [],
    history: [],
    historyComposers: [],
    historySearch: "",
    busy: false,
    paletteOpen: false,
    palette: { open: false, query: "", selected: 0 },
    modePicker: { open: false, selected: 0 },
    filePicker: { open: false, query: "", selected: 0, items: idle, kind: "file" },
    threadSwitcher: { open: false, query: "", selected: 0 },
    shortcutsOpen: false,
    composerHeight: 5,
    width: 80,
    height: 24,
    scrollOffset: 0,
    scrollFollow: true,
    threads: [],
    sidebarOpen: false,
    selectedThread: 0,
    permissionSelection: 0,
    queueSelection: undefined,
    queue: [],
    seenEventIds: [],
    seenExecutionEventKeys: [],
    activeTurnId: undefined,
    fastMode: false,
    reasoningEffort: defaultReasoningEffort(mode),
    changedFilesOpen: false,
    changedFiles: idle,
    sidebarWidth: 36,
    threadLoading: false,
    threadPreview: idle,
    toolCallDrafts: [],
  }),
)

export const inputRows = (model: Model): number => {
  const width = Math.max(1, model.width - 4)
  return Math.min(
    8,
    Math.max(
      1,
      displayInput(model)
        .split("\n")
        .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0),
    ),
  )
}

export const composerHeight = (model: Model): number =>
  Math.min(Math.max(5, model.height - 4), Math.max(5, model.composerHeight, inputRows(model) + 2))
export const isNarrow = (model: Model): boolean => model.width < 60

export type PromptSubmission =
  | { readonly _tag: "Prompt"; readonly prompt: string }
  | { readonly _tag: "Shell"; readonly command: string; readonly incognito: boolean }

export const classifyPrompt = (input: string): PromptSubmission => {
  if (input.startsWith("$$")) return { _tag: "Shell", command: input.slice(2).trimStart(), incognito: true }
  if (input.startsWith("$")) return { _tag: "Shell", command: input.slice(1).trimStart(), incognito: false }
  return { _tag: "Prompt", prompt: input }
}

const imagePathPattern =
  /\[([^\]\n]+\.(?:png|jpe?g|gif|webp))\]|(?:file:\/\/[^\s]+\.(?:png|jpe?g|gif|webp))|(?:(?:\\ |[^\s[\]])+\.(?:png|jpe?g|gif|webp))/gi

const appendPromptPart = (parts: Array<PromptPart>, part: PromptPart): void => {
  const previous = parts.at(-1)
  if (part.type === "text" && previous?.type === "text") {
    parts[parts.length - 1] = { type: "text", text: previous.text + part.text }
    return
  }
  parts.push(part)
}

const appendParsedText = (parts: Array<PromptPart>, text: string): void => {
  let offset = 0
  for (const match of text.matchAll(imagePathPattern)) {
    const index = match.index
    if (index > offset) appendPromptPart(parts, { type: "text", text: text.slice(offset, index) })
    const value = match[1] ?? match[0]
    let path = value
    if (path.startsWith("file://")) {
      try {
        path = decodeURIComponent(new URL(path).pathname)
      } catch {}
    }
    appendPromptPart(parts, { type: "image", path: path.replace(/\\ /g, " ") })
    offset = index + match[0].length
  }
  if (offset < text.length) appendPromptPart(parts, { type: "text", text: text.slice(offset) })
}

export const promptParts: {
  (input: string, pastedText?: ReadonlyArray<ComposerAttachment>): ReadonlyArray<PromptPart>
  (pastedText?: ReadonlyArray<ComposerAttachment>): (input: string) => ReadonlyArray<PromptPart>
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] === "string",
  (input: string, pastedText: ReadonlyArray<ComposerAttachment> = []): ReadonlyArray<PromptPart> => {
    const parts: Array<PromptPart> = []
    for (const value of input.split(/([\uE000-\uF8FF])/u)) {
      const attachment = pastedText.find((candidate) => candidate.token === value)
      if (attachment?.type === "image") appendPromptPart(parts, { type: "image", path: attachment.path })
      else appendParsedText(parts, attachment?.type === "text" ? attachment.value : value)
    }
    return parts.length === 0 ? [{ type: "text", text: "" }] : parts
  },
)

const insert = (model: Model, value: string): Model => ({
  ...model,
  input: model.input.slice(0, model.cursor) + value + model.input.slice(model.cursor),
  cursor: model.cursor + value.length,
  historyIndex: undefined,
  historyDraft: undefined,
})

const erase = (value: Model, length: number): Model => ({
  ...value,
  input: value.input.slice(0, Math.max(0, value.cursor - length)) + value.input.slice(value.cursor),
  cursor: Math.max(0, value.cursor - length),
})

const pastedImagePath = (value: string): string | undefined => {
  const trimmed = value.trim()
  const quoted = (/^'.*'$/s.test(trimmed) || /^".*"$/s.test(trimmed)) && trimmed.length >= 2
  const unquoted = quoted ? trimmed.slice(1, -1) : trimmed
  const pathLike =
    quoted || /^(?:file:\/\/|~\/|\.{0,2}\/|\/)/i.test(unquoted) || unquoted.includes("\\ ") || !/\s/.test(unquoted)
  if (!pathLike || !/\.(?:png|jpe?g|gif|webp)$/i.test(unquoted)) return undefined
  if (unquoted.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(unquoted).pathname)
    } catch {}
  }
  return unquoted.replace(/\\ /g, " ")
}

const insertPaste = (model: Model, value: string): Model => {
  const imagePath = pastedImagePath(value)
  if (imagePath !== undefined) return insertImage(model, imagePath)
  if (!value.includes("\n") && !value.includes("\r") && value.length <= 120) return insert(model, value)
  const token = String.fromCharCode(0xe000 + model.pastedText.length)
  const lines = value.split(/\r\n|\r|\n/).length
  const label =
    lines > 1
      ? `[Pasted text #${model.pastedText.length + 1} +${lines} lines]`
      : `[Pasted text #${model.pastedText.length + 1}]`
  const next = insert(model, token)
  return { ...next, pastedText: [...model.pastedText, { type: "text", token, value, label }] }
}

const insertImage = (model: Model, path: string): Model => {
  const token = String.fromCharCode(0xe000 + model.pastedText.length)
  const imageCount = model.pastedText.filter((attachment) => attachment.type === "image").length
  const next = insert(model, token)
  return {
    ...next,
    pastedText: [...model.pastedText, { type: "image", token, path, label: `[Image #${imageCount + 1}]` }],
  }
}

const removeImage = (model: Model, path: string): Model => {
  const attachment = model.pastedText.find(
    (candidate): candidate is Extract<ComposerAttachment, { readonly type: "image" }> =>
      candidate.type === "image" && candidate.path === path,
  )
  if (attachment === undefined) return model
  const offset = model.input.indexOf(attachment.token)
  return {
    ...model,
    input: model.input.replace(attachment.token, ""),
    cursor: offset >= 0 && model.cursor > offset ? model.cursor - attachment.token.length : model.cursor,
    pastedText: model.pastedText.filter((candidate) => candidate !== attachment),
  }
}

export const displayInput = (model: Model): string =>
  model.pastedText.reduce((text, attachment) => text.replaceAll(attachment.token, attachment.label), model.input)

export const expandPastedText: {
  (input: string, pastedText: ReadonlyArray<ComposerAttachment>): string
  (pastedText: ReadonlyArray<ComposerAttachment>): (input: string) => string
} = Function.dual(2, (input: string, pastedText: ReadonlyArray<ComposerAttachment>): string =>
  pastedText.reduce(
    (text, attachment) =>
      text.replaceAll(attachment.token, attachment.type === "image" ? attachment.label : attachment.value),
    input,
  ),
)

export const pastedTextTokenAt: {
  (model: Model, displayOffset: number): string | undefined
  (displayOffset: number): (model: Model) => string | undefined
} = Function.dual(2, (model: Model, displayOffset: number): string | undefined => {
  let offset = 0
  for (const part of model.input.split(/([\uE000-\uF8FF])/u)) {
    const attachment = model.pastedText.find((candidate) => candidate.token === part)
    const width = attachment?.label.length ?? part.length
    if (attachment !== undefined && displayOffset >= offset && displayOffset < offset + width) return attachment.token
    offset += width
  }
  return undefined
})

const expandPastedTextAttachment = (model: Model, token: string): Model => {
  const attachment = model.pastedText.find((candidate) => candidate.token === token)
  const tokenOffset = model.input.indexOf(token)
  if (attachment === undefined || attachment.type === "image" || tokenOffset < 0) return model
  return {
    ...model,
    input: model.input.replace(token, attachment.value),
    cursor: model.cursor > tokenOffset ? model.cursor + attachment.value.length - token.length : model.cursor,
    pastedText: model.pastedText.filter((candidate) => candidate.token !== token),
  }
}

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

const markThreadActive = (threads: ReadonlyArray<ThreadItem>, threadId: string): ReadonlyArray<ThreadItem> => {
  const next: Array<ThreadItem> = []
  for (const thread of threads) next.push({ ...thread, active: thread.id === threadId })
  return next
}

const renameThread = (
  threads: ReadonlyArray<ThreadItem>,
  threadId: string,
  title: string,
): ReadonlyArray<ThreadItem> => {
  const next: Array<ThreadItem> = []
  for (const thread of threads) next.push(thread.id === threadId ? { ...thread, title } : thread)
  return next
}

export const canSubmit = (model: Model): boolean =>
  !model.threadSwitcher.open &&
  !model.paletteOpen &&
  !model.palette.open &&
  !model.modePicker.open &&
  !model.filePicker.open &&
  !model.shortcutsOpen &&
  !(model.cursor > 0 && model.input[model.cursor - 1] === "\\") &&
  model.blocks.every((block) => {
    const candidate = block as TranscriptBlock
    return candidate._tag !== "Permission" || candidate.status !== "pending"
  })

export const update: {
  (model: Model, message: Message): Model
  (message: Message): (model: Model) => Model
} = Function.dual(2, (model: Model, message: Message): Model => {
  switch (message._tag) {
    case "Pasted":
      return insertPaste(model, message.text)
    case "ImageInserted":
      return insertImage(model, message.path)
    case "ImageRemoved":
      return removeImage(model, message.path)
    case "PastedTextExpanded":
      return expandPastedTextAttachment(model, message.token)
    case "ThreadsReplaced": {
      const threads: Array<ThreadItem> = []
      for (const thread of message.threads)
        threads.push(thread.id === model.currentThreadId ? { ...thread, active: true } : thread)
      return {
        ...model,
        threads,
        selectedThread: Math.min(model.selectedThread, Math.max(0, message.threads.length - 1)),
      }
    }
    case "ThreadActivated":
      return {
        ...model,
        currentThreadId: message.threadId,
        currentThreadTitle: message.title,
        threads: markThreadActive(model.threads as ReadonlyArray<ThreadItem>, message.threadId),
      }
    case "ThreadTitleChanged":
      return {
        ...model,
        currentThreadTitle: model.currentThreadId === message.threadId ? message.title : model.currentThreadTitle,
        threads: renameThread(model.threads as ReadonlyArray<ThreadItem>, message.threadId, message.title),
      }
    case "FilesRequested":
      return model.filePicker.items._tag === "Ready"
        ? model
        : { ...model, filePicker: { ...model.filePicker, items: loading } }
    case "FilesReplaced":
      return { ...model, filePicker: { ...model.filePicker, items: ready([...message.files]) } }
    case "BranchDetected":
      return { ...model, branch: message.branch }
    case "SidebarToggled":
      return { ...model, sidebarOpen: !model.sidebarOpen, changedFilesOpen: false }
    case "ThreadSelectionMoved":
      return {
        ...model,
        selectedThread: Math.max(0, Math.min(model.threads.length - 1, model.selectedThread + message.offset)),
      }
    case "ThreadSelectionConfirmed": {
      const thread = (model.threads as ReadonlyArray<ThreadItem>)[model.selectedThread]
      return thread !== undefined ? { ...model, pendingAction: { _tag: "SelectThread", id: thread.id } } : model
    }
    case "PermissionSelectionMoved":
      return { ...model, permissionSelection: (model.permissionSelection + message.offset + 3) % 3 }
    case "PermissionDecisionSelected": {
      const decisions = ["allow", "always", "deny"] as const
      const decision = message.decision ?? decisions[model.permissionSelection]!
      const permission = (model.blocks as ReadonlyArray<TranscriptBlock>).find(
        (block): block is Extract<TranscriptBlock, { _tag: "Permission" }> =>
          block._tag === "Permission" && block.id === message.id,
      )
      if (permission?.kind === undefined) return model
      return {
        ...model,
        blocks: model.blocks.map((block) =>
          (block as TranscriptBlock)._tag === "Permission" &&
          (block as Extract<TranscriptBlock, { _tag: "Permission" }>).id === message.id
            ? {
                ...(block as Extract<TranscriptBlock, { _tag: "Permission" }>),
                status: decision === "deny" ? ("denied" as const) : ("approved" as const),
              }
            : block,
        ),
        pendingAction: { _tag: "DecidePermission", id: message.id, kind: permission.kind, decision },
      }
    }
    case "EventReplayed":
      if (model.seenEventIds.includes(message.event.id)) return model
      {
        const incoming = message.event.block
        const blocks = [...model.blocks] as Array<TranscriptBlock>
        let items = [...model.items] as Array<TranscriptItem>
        const lastItem = items.at(-1)
        const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
        if (
          incoming._tag === "Reasoning" &&
          last?._tag === "Reasoning" &&
          lastItem?._tag === "Block" &&
          lastItem.turnId === message.event.turnId
        )
          blocks[lastItem.index] = { ...last, text: last.text + incoming.text }
        else if (incoming._tag === "ToolResult") {
          const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
          if (index >= 0) {
            const requested = blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
            blocks[index] = {
              ...requested,
              output: incoming.output,
              status: incoming.failed ? "failed" : "complete",
            }
          } else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else if (incoming._tag === "ToolCall") {
          const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
          if (index >= 0) blocks[index] = { ...(blocks[index] as typeof incoming), ...incoming }
          else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else if (incoming._tag === "Permission") {
          const index = blocks.findIndex((candidate) => candidate._tag === "Permission" && candidate.id === incoming.id)
          if (index >= 0) blocks[index] = { ...(blocks[index] as typeof incoming), ...incoming }
          else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else {
          items.push({
            _tag: "Block",
            index: blocks.length,
            ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
          })
          blocks.push(incoming)
        }
        return {
          ...model,
          blocks,
          items,
          seenEventIds: [...model.seenEventIds, message.event.id],
          eventCursor: message.event.cursor,
          ...(incoming._tag === "ToolCall"
            ? {
                toolCallDrafts: (
                  model.toolCallDrafts as ReadonlyArray<{ id: string; name?: string; text: string }>
                ).filter((draft) => draft.id !== incoming.id),
              }
            : {}),
          ...(model.busy
            ? {
                busyStatus:
                  incoming._tag === "ToolCall"
                    ? "Working"
                    : incoming._tag === "ToolResult"
                      ? "Waiting"
                      : incoming._tag === "Reasoning"
                        ? "Thinking"
                        : model.busyStatus,
              }
            : {}),
        }
      }
    case "Resized":
      return {
        ...model,
        width: message.width,
        height: message.height,
        composerHeight: Math.min(model.composerHeight, Math.max(5, message.height - 4)),
        sidebarWidth: clampSidebarWidth(model.sidebarWidth, message.width),
      }
    case "ComposerHeightChanged":
      return { ...model, composerHeight: Math.max(5, Math.min(message.height, Math.max(5, model.height - 4))) }
    case "SidebarWidthChanged":
      return { ...model, sidebarWidth: clampSidebarWidth(message.width, model.width) }
    case "ScrollMoved":
      return { ...model, scrollOffset: Math.max(0, message.offset), scrollFollow: false }
    case "ScrollFollowed":
      return { ...model, scrollOffset: 0, scrollFollow: true }
    case "Submitted":
      if (model.input.length === 0) return model
      const submission = classifyPrompt(model.input)
      const submittedPrompt = expandPastedText(model.input, model.pastedText)
      return submission._tag === "Shell" && submission.command.length === 0
        ? model
        : {
            ...model,
            input: "",
            cursor: 0,
            pastedText: [],
            history: [...model.history.filter((prompt) => prompt !== submittedPrompt), submittedPrompt],
            historyComposers: [
              ...model.historyComposers.filter(
                (draft) => expandPastedText(draft.input, draft.attachments) !== submittedPrompt,
              ),
              { input: model.input, attachments: model.pastedText },
            ],
            historyDraft: undefined,
            historyIndex: undefined,
            historySearch: "",
            busy: true,
            busyStatus: "Waiting",
            toolCallDrafts: [],
          }
    case "TurnStarted":
      if (model.entries.some((entry) => entry.role === "user" && entry.turnId === message.turnId))
        return { ...model, activeTurnId: message.turnId, busy: true, busyStatus: "Waiting" }
      return {
        ...model,
        entries: [...model.entries, { role: "user", text: message.prompt, turnId: message.turnId }],
        items: [...model.items, { _tag: "Entry", index: model.entries.length, turnId: message.turnId }],
        activeTurnId: message.turnId,
        busy: true,
        busyStatus: "Waiting",
      }
    case "SubmissionQueued":
      return model
    case "BlockAdded":
      return {
        ...model,
        blocks: [...model.blocks, message.block],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
      }
    case "ReasoningStreamed": {
      const blocks = [...model.blocks] as Array<TranscriptBlock>
      const lastItem = model.items.at(-1) as TranscriptItem | undefined
      const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
      if (last?._tag === "Reasoning" && lastItem?._tag === "Block")
        blocks[lastItem.index] = { ...last, text: last.text + message.text }
      else {
        blocks.push({ _tag: "Reasoning", text: message.text, expanded: false })
        return {
          ...model,
          blocks,
          items: [...model.items, { _tag: "Block", index: model.blocks.length }],
          ...(model.busy ? { busyStatus: "Thinking" } : {}),
        }
      }
      return { ...model, blocks, ...(model.busy ? { busyStatus: "Thinking" } : {}) }
    }
    case "ReasoningToggled":
      return {
        ...model,
        blocks: model.blocks.map((block, index) =>
          index === message.index && (block as TranscriptBlock)._tag === "Reasoning"
            ? {
                ...(block as Extract<TranscriptBlock, { _tag: "Reasoning" }>),
                expanded: !(block as Extract<TranscriptBlock, { _tag: "Reasoning" }>).expanded,
              }
            : block,
        ),
      }
    case "QueuedEdited":
      return {
        ...model,
        blocks: model.blocks.map((block, index) =>
          index === message.index && (block as TranscriptBlock)._tag === "Queued"
            ? { ...(block as Extract<TranscriptBlock, { _tag: "Queued" }>), prompt: message.prompt }
            : block,
        ),
      }
    case "QueuedDequeued":
      if ((model.blocks[message.index] as TranscriptBlock | undefined)?._tag !== "Queued") return model
      return replaceQueue(
        model,
        model.blocks
          .filter((block, index) => index !== message.index && (block as TranscriptBlock)._tag === "Queued")
          .map((block) => {
            const queued = block as Extract<TranscriptBlock, { _tag: "Queued" }>
            return { id: queued.id, prompt: queued.prompt }
          }),
      )
    case "PaletteActionConsumed":
      return { ...model, pendingAction: undefined }
    case "AssistantStreamed": {
      const entries = [...model.entries]
      const lastItem = (model.items as ReadonlyArray<TranscriptItem>).findLast(
        (item) => message.turnId === undefined || item.turnId === message.turnId,
      ) as TranscriptItem | undefined
      const index =
        lastItem?._tag === "Entry" &&
        entries[lastItem.index]?.role === "assistant" &&
        (message.turnId !== undefined || model.busyStatus === "Streaming")
          ? lastItem.index
          : -1
      if (index >= 0) entries[index] = { ...entries[index]!, text: entries[index]!.text + message.text }
      else
        entries.push({
          role: "assistant",
          text: message.text,
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        })
      return {
        ...model,
        entries,
        items:
          index >= 0
            ? model.items
            : [
                ...model.items,
                {
                  _tag: "Entry",
                  index: entries.length - 1,
                  ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
                } as const,
              ],
        busy: true,
        busyStatus: "Streaming",
      }
    }
    case "AssistantCompleted": {
      const entries = [...model.entries]
      const lastItem = (model.items as ReadonlyArray<TranscriptItem>).findLast(
        (item) => message.turnId === undefined || item.turnId === message.turnId,
      ) as TranscriptItem | undefined
      const index =
        lastItem?._tag === "Entry" &&
        entries[lastItem.index]?.role === "assistant" &&
        (message.turnId !== undefined || model.busyStatus === "Streaming")
          ? lastItem.index
          : -1
      if (index >= 0) entries[index] = { ...entries[index]!, text: message.text }
      else
        entries.push({
          role: "assistant",
          text: message.text,
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        })
      return {
        ...model,
        entries,
        items:
          index >= 0
            ? model.items
            : [...model.items, { _tag: "Entry", index: entries.length - 1, turnId: message.turnId }],
        busy: model.busy,
        busyStatus: model.busy ? "Working" : undefined,
      }
    }
    case "ExecutionCompleted":
      return message.turnId !== undefined && model.activeTurnId !== message.turnId
        ? model
        : { ...model, busy: false, busyStatus: undefined, activeTurnId: undefined }
    case "ExecutionFailed":
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      return {
        ...model,
        blocks: [
          ...model.blocks,
          {
            _tag: "Error",
            title: "Execution failed",
            detail: message.message,
            recovery: "Edit your prompt and press Enter to try again.",
          },
        ],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
        busy: false,
        busyStatus: undefined,
        activeTurnId: undefined,
      }
    case "ExecutionCancelled":
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      if (!model.busy) return model
      return {
        ...model,
        entries: [...model.entries, { role: "notice", text: "cancelled" }],
        items: [...model.items, { _tag: "Entry", index: model.entries.length }],
        busy: false,
        busyStatus: undefined,
        activeTurnId: undefined,
      }
    case "UsageReported":
      return message.costUsd === undefined ? model : { ...model, costUsd: (model.costUsd ?? 0) + message.costUsd }
    case "DetailMoved": {
      const units = expandableUnits(model)
      const count = units.length
      if (count === 0) return model
      const current = units.findIndex((unit) => transcriptUnitId(model, unit) === model.detailSelection)
      const nextIndex =
        current < 0 ? (message.offset < 0 ? count - 1 : 0) : (((current + message.offset) % count) + count) % count
      return { ...model, detailSelection: transcriptUnitId(model, units[nextIndex]!) }
    }
    case "DetailToggled": {
      const units = expandableUnits(model)
      const id = message.id ?? model.detailSelection
      if (id === undefined) return model
      const unit = units.find((candidate) => transcriptUnitId(model, candidate) === id)
      if (unit === undefined) return model
      const targets = new Set(unitToggleTargets(unit))
      const groupExpanded = [...targets].some(
        (blockIndex) => (model.blocks[blockIndex] as TranscriptBlock & { expanded?: boolean }).expanded === true,
      )
      return {
        ...model,
        detailSelection: id,
        blocks: model.blocks.map((block, blockIndex) =>
          targets.has(blockIndex) ? { ...(block as object), expanded: !groupExpanded } : block,
        ),
      }
    }
    case "FastModeToggled":
      return { ...model, fastMode: !model.fastMode }
    case "ReasoningEffortCycled": {
      const efforts = ["low", "medium", "high", "xhigh"] as const
      return { ...model, reasoningEffort: efforts[(efforts.indexOf(model.reasoningEffort) + 1) % efforts.length]! }
    }
    case "SidebarViewToggled":
      return { ...model, changedFilesOpen: !model.changedFilesOpen, sidebarOpen: false }
    case "ChangedFilesRequested":
      return model.changedFiles._tag === "Ready" ? model : { ...model, changedFiles: loading }
    case "ChangedFilesReplaced":
      return { ...model, changedFiles: ready([...message.files]) }
    case "ThreadPreviewRequested":
      return { ...model, threadPreview: loading }
    case "ThreadOpenRequested":
      return { ...model, threadLoading: true }
    case "ThreadOpenCompleted":
      return { ...model, threadLoading: false }
    case "ThreadPreviewLoaded":
      return {
        ...model,
        threadPreview: ready({
          threadId: message.threadId,
          turns: message.turns.map((turn) => ({ prompt: turn.prompt, events: [...turn.events] })),
        }),
      }
    case "ToolCallDeltaReceived": {
      const drafts = model.toolCallDrafts as ReadonlyArray<{ id: string; name?: string; text: string }>
      const index = drafts.findIndex((draft) => draft.id === message.id)
      const previous = index >= 0 ? drafts[index]! : undefined
      const name = message.name ?? previous?.name
      const updated = {
        id: message.id,
        text: (previous?.text ?? "") + message.delta,
        ...(name === undefined ? {} : { name }),
      }
      const next = previous === undefined ? [...drafts, updated] : drafts.slice()
      if (previous !== undefined) next[index] = updated
      return { ...model, toolCallDrafts: next }
    }
    case "ComposerReplaced":
      return { ...model, input: message.text, cursor: message.text.length, pastedText: [] }
    case "KeyPressed": {
      const key = message.key
      if (key.eventType === "release") return model
      if (!key.ctrl && !key.alt && !key.meta && key.name === "pageup")
        return {
          ...model,
          scrollOffset: Math.max(0, model.scrollOffset - Math.max(1, model.height - 6)),
          scrollFollow: false,
        }
      if (!key.ctrl && !key.alt && !key.meta && key.name === "pagedown")
        return {
          ...model,
          scrollOffset: model.scrollOffset + Math.max(1, model.height - 6),
          scrollFollow: false,
        }
      if (!key.ctrl && !key.alt && !key.meta && key.name === "end")
        return { ...model, scrollOffset: 0, scrollFollow: true }
      if ((key.ctrl && key.name === "t") || (key.alt && key.name === "w")) {
        const open = !model.threadSwitcher.open
        return {
          ...model,
          threadSwitcher: { open, query: "", selected: 0 },
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false, kind: "file" },
          shortcutsOpen: false,
          ...(open ? {} : { threadPreview: idle }),
        }
      }
      if (model.threadSwitcher.open) {
        const threads = filteredThreads(model)
        if (key.name === "escape")
          return { ...model, threadSwitcher: { open: false, query: "", selected: 0 }, threadPreview: idle }
        if (key.name === "return") {
          const thread = threads[model.threadSwitcher.selected]
          return thread === undefined
            ? model
            : {
                ...model,
                threadSwitcher: { open: false, query: "", selected: 0 },
                threadPreview: idle,
                pendingAction: { _tag: "SelectThread", id: thread.id },
              }
        }
        if (key.name === "backspace")
          return {
            ...model,
            threadSwitcher: { open: true, query: model.threadSwitcher.query.slice(0, -1), selected: 0 },
          }
        const selected =
          key.name === "up"
            ? (model.threadSwitcher.selected + Math.max(1, threads.length) - 1) % Math.max(1, threads.length)
            : key.name === "down"
              ? (model.threadSwitcher.selected + 1) % Math.max(1, threads.length)
              : model.threadSwitcher.selected
        return isPrintable(key)
          ? { ...model, threadSwitcher: { open: true, query: model.threadSwitcher.query + key.sequence, selected: 0 } }
          : { ...model, threadSwitcher: { ...model.threadSwitcher, selected } }
      }
      if (key.ctrl && key.name === "o") {
        const open = !model.palette.open
        return {
          ...model,
          paletteOpen: open,
          palette: { open, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false },
          shortcutsOpen: false,
        }
      }
      if (!model.filePicker.open && !key.ctrl && !key.alt && !key.meta && key.sequence === "@")
        return insert(
          {
            ...model,
            paletteOpen: false,
            palette: { open: false, query: "", selected: 0 },
            modePicker: { ...model.modePicker, open: false },
            filePicker: { ...model.filePicker, open: true, query: "", selected: 0, kind: "file" },
            shortcutsOpen: false,
          },
          "@",
        )
      if (key.ctrl && (key.name === "s" || key.name === "m") && !model.busy) {
        if (model.modePicker.open)
          return { ...model, modePicker: { open: true, selected: (model.modePicker.selected + 1) % 4 } }
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { open: true, selected: ["low", "medium", "high", "ultra"].indexOf(model.mode) },
          filePicker: { ...model.filePicker, open: false },
          shortcutsOpen: false,
        }
      }
      if (!key.ctrl && !key.alt && !key.meta && key.sequence === "?" && !model.busy && model.input.length === 0)
        return {
          ...model,
          shortcutsOpen: !model.shortcutsOpen,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false },
        }
      if (key.ctrl && key.name === "c" && model.busy) return { ...model, pendingAction: { _tag: "Cancel" } }
      if (key.ctrl && key.name === "s" && model.busy && model.input.length > 0)
        return { ...model, pendingAction: { _tag: "Steer", prompt: model.input }, input: "", cursor: 0 }
      if (key.ctrl && key.name === "return" && model.busy && model.input.length > 0)
        return { ...model, pendingAction: { _tag: "InterruptAndSend", prompt: model.input }, input: "", cursor: 0 }
      if (key.alt && key.name === "t") {
        return update(model, { _tag: "SidebarToggled" })
      }
      if (key.alt && key.name === "d") return update(model, { _tag: "ReasoningEffortCycled" })
      if (key.alt && key.name === "s") return update(model, { _tag: "SidebarViewToggled" })
      if (
        key.name === "escape" &&
        (model.palette.open || model.modePicker.open || model.filePicker.open || model.shortcutsOpen)
      )
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false, query: "", selected: 0, kind: "file" },
          shortcutsOpen: false,
        }
      if (model.shortcutsOpen) return model
      if (model.modePicker.open) {
        const selected =
          key.name === "left" || key.name === "up"
            ? (model.modePicker.selected + 3) % 4
            : key.name === "right" || key.name === "down"
              ? (model.modePicker.selected + 1) % 4
              : model.modePicker.selected
        const mode = model.busy ? model.mode : (["low", "medium", "high", "ultra"] as const)[selected]!
        const reasoningEffort = mode === model.mode ? model.reasoningEffort : defaultReasoningEffort(mode)
        if (key.name === "return") return { ...model, mode, reasoningEffort, modePicker: { open: false, selected } }
        return { ...model, mode, reasoningEffort, modePicker: { open: true, selected } }
      }
      if (model.palette.open) {
        const results = filter(model.palette.query)
        const selected =
          key.name === "up"
            ? Math.max(0, model.palette.selected - 1)
            : key.name === "down"
              ? Math.max(0, Math.min(results.length - 1, model.palette.selected + 1))
              : model.palette.selected
        if (key.name === "return") {
          const action = results[selected]?.action as PaletteAction | undefined
          if (action === undefined) return { ...model, palette: { ...model.palette, selected: 0 } }
          if (action._tag === "OpenModePicker")
            return model.busy
              ? {
                  ...model,
                  paletteOpen: false,
                  palette: { open: false, query: "", selected: 0 },
                }
              : {
                  ...model,
                  paletteOpen: false,
                  palette: { open: false, query: "", selected: 0 },
                  modePicker: { open: true, selected: ["low", "medium", "high", "ultra"].indexOf(model.mode) },
                }
          if (action._tag === "SwitchThread")
            return {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
              threadSwitcher: { open: true, query: "", selected: 0 },
            }
          if (action._tag === "ToggleFastMode")
            return {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
              fastMode: !model.fastMode,
            }
          return {
            ...model,
            paletteOpen: false,
            palette: { open: false, query: "", selected: 0 },
            pendingAction: action,
          }
        }
        if (key.name === "backspace")
          return { ...model, palette: { ...model.palette, query: model.palette.query.slice(0, -1), selected: 0 } }
        return isPrintable(key)
          ? { ...model, palette: { ...model.palette, query: model.palette.query + key.sequence, selected: 0 } }
          : { ...model, palette: { ...model.palette, selected } }
      }
      if (model.filePicker.open) {
        const mentionLength = Math.min(
          (model.filePicker.kind === "thread" ? 2 : 1) + model.filePicker.query.length,
          model.cursor,
        )
        if (
          isPrintable(key) &&
          key.sequence === "@" &&
          model.filePicker.kind === "file" &&
          model.filePicker.query === ""
        )
          return insert({ ...model, filePicker: { ...model.filePicker, kind: "thread", selected: 0 } }, "@")
        const threadItems = (model.threads as ReadonlyArray<ThreadItem>).filter((thread) =>
          `${thread.title} ${thread.workspace ?? ""} ${thread.id}`
            .toLowerCase()
            .includes(model.filePicker.query.toLowerCase()),
        )
        const files = filteredFiles(model)
        const candidates = model.filePicker.kind === "thread" ? threadItems : files
        const selected =
          key.name === "up"
            ? (model.filePicker.selected + Math.max(1, candidates.length) - 1) % Math.max(1, candidates.length)
            : key.name === "down"
              ? (model.filePicker.selected + 1) % Math.max(1, candidates.length)
              : model.filePicker.selected
        if (key.name === "return") {
          const file = files[selected]
          const thread = threadItems[selected]
          if (model.filePicker.kind === "thread")
            return thread === undefined
              ? { ...model, filePicker: { ...model.filePicker, open: false } }
              : insert(
                  erase(
                    {
                      ...model,
                      filePicker: { ...model.filePicker, open: false, query: "", selected: 0, kind: "file" },
                    },
                    mentionLength,
                  ),
                  `@thread:"${thread.id}" `,
                )
          return file === undefined
            ? { ...model, filePicker: { ...model.filePicker, open: false } }
            : insert(
                erase(
                  { ...model, filePicker: { ...model.filePicker, open: false, query: "", selected: 0 } },
                  mentionLength,
                ),
                `@${file} `,
              )
        }
        if (key.name === "backspace") {
          if (model.filePicker.query.length > 0)
            return erase(
              {
                ...model,
                filePicker: { ...model.filePicker, query: model.filePicker.query.slice(0, -1), selected: 0 },
              },
              1,
            )
          if (model.filePicker.kind === "thread")
            return erase({ ...model, filePicker: { ...model.filePicker, kind: "file", selected: 0 } }, 1)
          return erase({ ...model, filePicker: { ...model.filePicker, open: false, selected: 0 } }, 1)
        }
        return isPrintable(key)
          ? insert(
              {
                ...model,
                filePicker: { ...model.filePicker, query: model.filePicker.query + key.sequence, selected: 0 },
              },
              key.sequence,
            )
          : { ...model, filePicker: { ...model.filePicker, selected } }
      }
      const permission = model.blocks.findLast((block) => {
        const candidate = block as TranscriptBlock
        return candidate._tag === "Permission" && candidate.status === "pending"
      }) as Extract<TranscriptBlock, { _tag: "Permission" }> | undefined
      if (permission !== undefined) {
        if (key.name === "left" || key.name === "up")
          return update(model, { _tag: "PermissionSelectionMoved", offset: -1 })
        if (key.name === "right" || key.name === "down" || key.name === "tab")
          return update(model, { _tag: "PermissionSelectionMoved", offset: 1 })
        if (key.name === "return") return update(model, { _tag: "PermissionDecisionSelected", id: permission.id })
      }
      if ((key.name === "tab" || key.name === "backtab") && !key.ctrl && !key.alt && !key.meta)
        return update(model, { _tag: "DetailMoved", offset: key.name === "backtab" || key.shift ? -1 : 1 })
      const queued = model.queue as ReadonlyArray<QueueItem>
      if (model.busy && model.input.length === 0 && queued.length > 0) {
        if (key.name === "up" || key.name === "down") {
          const current = queued.findIndex((item) => item.id === model.queueSelection)
          const index =
            current < 0
              ? key.name === "up"
                ? queued.length - 1
                : 0
              : (current + (key.name === "up" ? -1 : 1) + queued.length) % queued.length
          return {
            ...model,
            queueSelection: queued[index]!.id,
          }
        }
        const selected = queued.find((item) => item.id === model.queueSelection) ?? queued[0]!
        if (key.name === "return")
          return {
            ...model,
            pendingAction: {
              _tag: "SteerQueued",
              id: selected.id,
              prompt: selected.prompt,
            },
          }
        if (key.name === "backspace") return { ...model, pendingAction: { _tag: "Dequeue", id: selected.id } }
      }
      if ((key.name === "return" && key.shift) || key.name === "linefeed" || (key.ctrl && key.name === "j"))
        return insert(model, "\n")
      if (key.name === "return" && model.cursor > 0 && model.input[model.cursor - 1] === "\\") {
        const withoutSlash = {
          ...model,
          input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
          cursor: model.cursor - 1,
        }
        return insert(withoutSlash, "\n")
      }
      if (key.name === "up" || key.name === "down") {
        if (model.history.length === 0) return model
        const lineStart = model.input.lastIndexOf("\n", Math.max(0, model.cursor - 1)) + 1
        const lineEnd = model.input.indexOf("\n", model.cursor)
        if (key.name === "up" && lineStart > 0) return model
        if (key.name === "down" && lineEnd >= 0) return model
        const current = model.historyIndex ?? model.history.length
        const index = key.name === "up" ? Math.max(0, current - 1) : Math.min(model.history.length, current + 1)
        const savedDraft =
          model.historyIndex === undefined ? { input: model.input, attachments: model.pastedText } : model.historyDraft
        const draft = index === model.history.length ? savedDraft : model.historyComposers[index]
        const input = draft?.input ?? (index === model.history.length ? "" : model.history[index]!)
        return {
          ...model,
          historyIndex: index === model.history.length ? undefined : index,
          historyDraft: index === model.history.length ? undefined : savedDraft,
          input,
          pastedText: draft?.attachments ?? [],
          cursor: input.length,
        }
      }
      if (key.ctrl && key.name === "r") {
        const query = model.input || model.historySearch
        const input = model.history.toReversed().find((prompt) => prompt.includes(query)) ?? model.input
        return { ...model, input, cursor: input.length, historySearch: query }
      }
      if (((key.alt && key.name === "backspace") || (key.ctrl && key.name === "w")) && model.cursor > 0) {
        const before = model.input.slice(0, model.cursor)
        const trimmed = before.replace(/[ \t]+$/, "")
        const boundary = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("\t"))
        const target = trimmed.length === 0 ? 0 : boundary + 1
        return { ...model, input: model.input.slice(0, target) + model.input.slice(model.cursor), cursor: target }
      }
      if (((key.meta && key.name === "backspace") || (key.ctrl && key.name === "u")) && model.cursor > 0) {
        const lineStart = model.input.lastIndexOf("\n", model.cursor - 1) + 1
        return {
          ...model,
          input: model.input.slice(0, lineStart) + model.input.slice(model.cursor),
          cursor: lineStart,
        }
      }
      if (key.name === "backspace" && model.cursor > 0) {
        return {
          ...model,
          input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
          cursor: model.cursor - 1,
        }
      }
      if (key.name === "left") return { ...model, cursor: Math.max(0, model.cursor - 1) }
      if (key.name === "right") return { ...model, cursor: Math.min(model.input.length, model.cursor + 1) }
      return isPrintable(key) ? insert(model, key.sequence) : model
    }
  }
})
