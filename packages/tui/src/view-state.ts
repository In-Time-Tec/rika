import type * as Transcript from "@rika/transcript"
import { Function, Schema } from "effect"
import stringWidth from "string-width"
import type { Key } from "./keys"
import { isPrintable } from "./keys"
import { filter, type PaletteAction } from "./palette"
import { expandableRowIds, transcriptUnitId, transcriptUnits } from "./transcript-units"

export const Mode = Schema.Literals(["low", "medium", "high", "ultra"])
export type Mode = typeof Mode.Type

export const Activity = Schema.Union([
  Schema.TaggedStruct("Sending", {}),
  Schema.TaggedStruct("Waiting", {}),
  Schema.TaggedStruct("Thinking", { bytes: Schema.Finite, blockId: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("Streaming", { bytes: Schema.Finite, blockId: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("RunningTools", {}),
])
export type Activity = typeof Activity.Type

export const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

export const formatActivityCounter = (tokens: number): string =>
  tokens < 1_000
    ? `${tokens} tok`
    : tokens < 10_000
      ? `${(tokens / 1_000).toFixed(2)}k tok`
      : tokens < 1_000_000
        ? `${(tokens / 1_000).toFixed(1)}k tok`
        : `${(tokens / 1_000_000).toFixed(1)}M tok`

export const formatActivity = (activity: Activity | undefined): string | undefined => {
  if (activity === undefined) return undefined
  if (activity._tag === "RunningTools") return "Running tools"
  if (activity._tag === "Thinking" || activity._tag === "Streaming") {
    const tokens = Math.floor(activity.bytes / 4)
    return `${activity._tag} ${formatActivityCounter(tokens)}`
  }
  return activity._tag
}

const streamActivityImpl = (
  current: Activity | undefined,
  tag: "Thinking" | "Streaming",
  text: string,
  blockId?: string,
): Activity => ({
  _tag: tag,
  bytes:
    current?._tag === tag && current.blockId === blockId ? current.bytes + utf8ByteLength(text) : utf8ByteLength(text),
  ...(blockId === undefined ? {} : { blockId }),
})

export const streamActivity: {
  (current: Activity | undefined, tag: "Thinking" | "Streaming", text: string, blockId: string | undefined): Activity
  (
    tag: "Thinking" | "Streaming",
    text: string,
    blockId: string | undefined,
  ): (current: Activity | undefined) => Activity
} = Function.dual(4, streamActivityImpl)

export const Entry = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "notice"]),
  text: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
})
export type Entry = typeof Entry.Type

export type TranscriptBlock = Transcript.Block

export interface ThreadItem {
  readonly id: string
  readonly title: string
  readonly workspace: string
  readonly pinned: boolean
  readonly archived: boolean
  readonly status: "idle" | "queued" | "running" | "waiting"
  readonly unread: boolean
  readonly lastActivityAt: number
  readonly editTotals?: { readonly added: number; readonly modified: number; readonly removed: number }
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
  | {
      readonly _tag: "Entry"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly parentId?: string
    }
  | {
      readonly _tag: "Block"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly parentId?: string
    }

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
}
export interface ThreadSwitcherState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
  readonly kind: "switch" | "mention"
  readonly previewScroll: number
}
export interface ThreadSidebarState {
  readonly open: boolean
  readonly focused: boolean
  readonly selected: number
  readonly scrollTop: number
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
})
const ThreadSwitcherStateSchema = Schema.Struct({
  open: Schema.Boolean,
  query: Schema.String,
  selected: Schema.Finite,
  kind: Schema.Literals(["switch", "mention"]),
  previewScroll: Schema.Finite,
})
const ThreadSidebarStateSchema = Schema.Struct({
  open: Schema.Boolean,
  focused: Schema.Boolean,
  selected: Schema.Finite,
  scrollTop: Schema.Finite,
})
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
const ThreadPreviewValueSchema = Schema.Struct({
  threadId: Schema.String,
  turns: Schema.Array(Schema.Struct({ prompt: Schema.String, events: Schema.Array(Schema.Unknown) })),
})
const ThreadPreviewSchema = Schema.Union([
  LoadableIdleSchema,
  Schema.TaggedStruct("Loading", { previous: Schema.optionalKey(ThreadPreviewValueSchema) }),
  Schema.TaggedStruct("Ready", { value: ThreadPreviewValueSchema }),
])

export const QueueItem = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type QueueItem = typeof QueueItem.Type

export type QueueChange =
  | { readonly _tag: "Added"; readonly item: QueueItem }
  | { readonly _tag: "Updated"; readonly item: QueueItem }
  | { readonly _tag: "Removed"; readonly turnId: string }

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
  activity: Schema.optional(Activity),
  costUsd: Schema.optional(Schema.Finite),
  paletteOpen: Schema.Boolean,
  palette: PaletteStateSchema,
  modePicker: ModePickerStateSchema,
  filePicker: FilePickerStateSchema,
  threadSwitcher: ThreadSwitcherStateSchema,
  shortcutsOpen: Schema.Boolean,
  shortcutsTrigger: Schema.optional(Schema.Finite),
  pendingAction: Schema.optional(Schema.Unknown),
  composerHeight: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  scrollOffset: Schema.Finite,
  scrollFollow: Schema.Boolean,
  threads: Schema.Array(Schema.Unknown),
  workspaceFilesOpen: Schema.Boolean,
  threadSidebar: ThreadSidebarStateSchema,
  permissionSelection: Schema.Finite,
  queueSelection: Schema.optional(Schema.String),
  queue: Schema.Array(QueueItem),
  queueThreadId: Schema.optional(Schema.String),
  queueRevision: Schema.optional(Schema.Int),
  editingTurnId: Schema.optional(Schema.String),
  editReturn: Schema.optional(ComposerDraftSchema),
  detailSelection: Schema.optional(Schema.String),
  expandedRowKeys: Schema.Array(Schema.String),
  seenEventIds: Schema.Array(Schema.String),
  seenExecutionEventKeys: Schema.Array(Schema.String),
  activeTurnId: Schema.optional(Schema.String),
  eventCursor: Schema.optional(Schema.String),
  currentThreadId: Schema.optional(Schema.String),
  currentThreadTitle: Schema.optional(Schema.String),
  fastMode: Schema.Boolean,
  changedFilesOpen: Schema.Boolean,
  changedFiles: ChangedFilesSchema,
  sidebarWidth: Schema.Finite,
  threadLoading: Schema.Boolean,
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
  | { readonly _tag: "AssistantStreamed"; readonly id?: string; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "AssistantCompleted"; readonly id?: string; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "ExecutionCompleted"; readonly turnId?: string }
  | { readonly _tag: "ExecutionFailed"; readonly turnId?: string; readonly message: string }
  | { readonly _tag: "ExecutionCancelled"; readonly turnId?: string }
  | { readonly _tag: "BlockAdded"; readonly block: TranscriptBlock }
  | { readonly _tag: "ReasoningStreamed"; readonly text: string }
  | { readonly _tag: "ReasoningToggled"; readonly index: number }
  | { readonly _tag: "ScrollMoved"; readonly offset: number }
  | { readonly _tag: "ScrollFollowed" }
  | { readonly _tag: "PaletteActionConsumed" }
  | { readonly _tag: "ThreadsReplaced"; readonly threads: ReadonlyArray<ThreadItem> }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "ThreadTitleChanged"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "FilesReplaced"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "BranchDetected"; readonly branch: string }
  | { readonly _tag: "UsageReported"; readonly costUsd?: number }
  | { readonly _tag: "WorkspaceFilesToggled" }
  | { readonly _tag: "ThreadSidebarSelectionMoved"; readonly offset: number }
  | { readonly _tag: "ThreadSidebarSelectionConfirmed"; readonly index?: number }
  | { readonly _tag: "ThreadPreviewScrolled"; readonly offset: number }
  | { readonly _tag: "PermissionSelectionMoved"; readonly offset: number }
  | { readonly _tag: "PermissionDecisionSelected"; readonly id: string; readonly decision?: PermissionDecision }
  | { readonly _tag: "EventReplayed"; readonly event: UiEvent }
  | { readonly _tag: "DetailMoved"; readonly offset: number }
  | { readonly _tag: "DetailToggled"; readonly id?: string }
  | { readonly _tag: "AllDetailsToggled" }
  | { readonly _tag: "FastModeToggled" }
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

const validQueueSelection = (current: string | undefined, queue: ReadonlyArray<QueueItem>): string | undefined =>
  current !== undefined && queue.some((item) => item.id === current) ? current : undefined

const exitEditWhenRemoved = (model: Model, queue: ReadonlyArray<QueueItem>): Partial<Model> => {
  if (model.editingTurnId === undefined || queue.some((item) => item.id === model.editingTurnId)) return {}
  const restore = model.editReturn ?? { input: "", attachments: [] }
  return {
    editingTurnId: undefined,
    editReturn: undefined,
    input: restore.input,
    cursor: restore.input.length,
    pastedText: [...restore.attachments],
  }
}

export const resetQueue: {
  (model: Model, threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): Model
  (threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): (model: Model) => Model
} = Function.dual(
  4,
  (model: Model, threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): Model => ({
    ...model,
    queue: [...queue],
    queueThreadId: threadId,
    queueRevision: revision,
    queueSelection: validQueueSelection(model.queueSelection, queue),
    ...exitEditWhenRemoved(model, queue),
  }),
)

export const applyQueueDelta: {
  (
    model: Model,
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): {
    readonly model: Model
    readonly resync: boolean
  }
  (
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): (model: Model) => {
    readonly model: Model
    readonly resync: boolean
  }
} = Function.dual(
  (args) => typeof args[0] !== "string",
  (
    model: Model,
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): { readonly model: Model; readonly resync: boolean } => {
    if (model.currentThreadId !== undefined && model.currentThreadId !== threadId) return { model, resync: false }
    if (model.queueThreadId !== threadId || model.queueRevision === undefined) return { model, resync: true }
    if (revision <= model.queueRevision) return { model, resync: false }
    if (revision !== model.queueRevision + 1) return { model, resync: true }
    const queue = [...model.queue]
    let selection = model.queueSelection
    if (change._tag === "Added") {
      if (queue.some((item) => item.id === change.item.id)) return { model, resync: true }
      queue.push(change.item)
    } else if (change._tag === "Updated") {
      const index = queue.findIndex((item) => item.id === change.item.id)
      if (index < 0) return { model, resync: true }
      queue[index] = change.item
    } else {
      const index = queue.findIndex((item) => item.id === change.turnId)
      if (index < 0) return { model, resync: true }
      queue.splice(index, 1)
      if (model.queueSelection === change.turnId) selection = queue[Math.min(index, queue.length - 1)]?.id
    }
    return {
      model: {
        ...model,
        queue,
        queueRevision: revision,
        queueSelection: validQueueSelection(selection, queue),
        ...exitEditWhenRemoved(model, queue),
      },
      resync: queuedCount !== undefined && queuedCount !== queue.length,
    }
  },
)

export const replaceTurnPrompt: {
  (model: Model, turnId: string, prompt: string): Model
  (turnId: string, prompt: string): (model: Model) => Model
} = Function.dual(3, (model: Model, turnId: string, prompt: string): Model => {
  const index = model.entries.findIndex((entry) => entry.role === "user" && entry.turnId === turnId)
  if (index < 0) return model
  const entries = [...model.entries]
  entries[index] = { ...entries[index]!, text: prompt }
  return { ...model, entries }
})

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
    filePicker: { open: false, query: "", selected: 0, items: idle },
    threadSwitcher: { open: false, query: "", selected: 0, kind: "switch", previewScroll: 0 },
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
    composerHeight: 5,
    width: 80,
    height: 24,
    scrollOffset: 0,
    scrollFollow: true,
    threads: [],
    workspaceFilesOpen: false,
    threadSidebar: { open: false, focused: false, selected: 0, scrollTop: 0 },
    permissionSelection: 0,
    queueSelection: undefined,
    queue: [],
    expandedRowKeys: [],
    seenEventIds: [],
    seenExecutionEventKeys: [],
    activeTurnId: undefined,
    fastMode: false,
    changedFilesOpen: false,
    changedFiles: idle,
    sidebarWidth: 36,
    threadLoading: false,
    threadPreview: idle,
  }),
)

export const isNarrow = (model: Model): boolean => model.width < 60

export const threadSidebarWidth = 36

export const boundedThreadSidebarWidth = (terminalWidth: number): number =>
  Math.min(threadSidebarWidth, Math.max(8, terminalWidth - 24))

export const contentColumnWidth = (model: Model): number => {
  const fileTreeVisible =
    !isNarrow(model) &&
    ((model.changedFilesOpen && isReady(model.changedFiles)) ||
      (model.workspaceFilesOpen && isReady(model.filePicker.items)))
  return Math.max(
    1,
    model.width -
      (fileTreeVisible ? model.sidebarWidth : 0) -
      (model.threadSidebar.open ? boundedThreadSidebarWidth(model.width) : 0),
  )
}

const wrappedRowsForLine = (text: string, width: number): number => {
  if (width <= 0) return 1
  let rows = 1
  let column = 0
  for (const character of text) {
    const cells = stringWidth(character)
    if (cells === 0) continue
    if (column + cells > width) {
      rows += 1
      column = cells
    } else column += cells
  }
  return rows
}

export const wrappedRowCount: {
  (text: string, width: number): number
  (width: number): (text: string) => number
} = Function.dual(2, (text: string, width: number): number =>
  text.split("\n").reduce((rows, line) => rows + wrappedRowsForLine(line, width), 0),
)

export const queueContentWidth = (model: Model): number => Math.max(1, contentColumnWidth(model) - 6)

export const inputRows = (model: Model): number =>
  Math.min(8, Math.max(1, wrappedRowCount(displayInput(model), Math.max(1, contentColumnWidth(model) - 4))))

export const composerHeight = (model: Model): number =>
  Math.min(Math.max(5, model.height - 4), Math.max(5, model.composerHeight, inputRows(model) + 2))

export type PromptSubmission =
  | { readonly _tag: "Prompt"; readonly prompt: string }
  | { readonly _tag: "Shell"; readonly command: string; readonly incognito: boolean }

export const classifyPrompt = (input: string): PromptSubmission => {
  if (input.startsWith("$$")) return { _tag: "Shell", command: input.slice(2).trimStart(), incognito: true }
  if (input.startsWith("$")) return { _tag: "Shell", command: input.slice(1).trimStart(), incognito: false }
  return { _tag: "Prompt", prompt: input }
}

const imagePathPattern =
  /@image:(?:"([^"]+\.(?:png|jpe?g|gif|webp))"|'([^']+\.(?:png|jpe?g|gif|webp))'|([^\s,;]+\.(?:png|jpe?g|gif|webp)))|\[([^\]\n]+\.(?:png|jpe?g|gif|webp))\]|(?:file:\/\/[^\s]+\.(?:png|jpe?g|gif|webp))|(?:(?:\\ |[^\s[\]])+\.(?:png|jpe?g|gif|webp))/gi

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
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[0]
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

const lastCharacterLength = (value: string): number => Array.from(value).at(-1)?.length ?? 0

const fileMention = (path: string): string => `@${/\s/u.test(path) ? `"${path}"` : path} `

const questionKey = (key: Key): boolean => !key.ctrl && !key.alt && !key.meta && key.sequence === "?"

const composerContext = (model: Model): boolean =>
  !model.threadSwitcher.open &&
  !model.threadSidebar.focused &&
  !model.paletteOpen &&
  !model.palette.open &&
  !model.modePicker.open &&
  !model.filePicker.open

const continueShortcutsAfterEdit = (before: Model, after: Model): Model => {
  const trigger = before.shortcutsTrigger
  if (trigger === undefined || before.input[trigger] !== "?" || !composerContext(after))
    return { ...after, shortcutsOpen: false, shortcutsTrigger: undefined }
  if (before.input === after.input) return { ...after, shortcutsOpen: true, shortcutsTrigger: trigger }
  let prefix = 0
  while (prefix < before.input.length && prefix < after.input.length && before.input[prefix] === after.input[prefix])
    prefix += 1
  let suffix = 0
  while (
    suffix < before.input.length - prefix &&
    suffix < after.input.length - prefix &&
    before.input[before.input.length - 1 - suffix] === after.input[after.input.length - 1 - suffix]
  )
    suffix += 1
  const oldEnd = before.input.length - suffix
  const nextTrigger =
    trigger < prefix ? trigger : trigger >= oldEnd ? trigger + after.input.length - before.input.length : -1
  return nextTrigger >= 0 && after.input[nextTrigger] === "?"
    ? { ...after, shortcutsOpen: true, shortcutsTrigger: nextTrigger }
    : { ...after, shortcutsOpen: false, shortcutsTrigger: undefined }
}

const insertWhileShortcutsOpen = (model: Model, value: string): Model => {
  const trigger = model.shortcutsTrigger
  const next = insert(model, value)
  return trigger === undefined
    ? next
    : { ...next, shortcutsTrigger: model.cursor <= trigger ? trigger + value.length : trigger }
}

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
  if (!value.includes("\n") && !value.includes("\r") && [...value].length <= 120) return insert(model, value)
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
  if (model.editingTurnId !== undefined) return model
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

const renameThread = (
  threads: ReadonlyArray<ThreadItem>,
  threadId: string,
  title: string,
): ReadonlyArray<ThreadItem> => {
  const next: Array<ThreadItem> = []
  for (const thread of threads) next.push(thread.id === threadId ? { ...thread, title } : thread)
  return next
}

const sameChangedFiles = (left: ReadonlyArray<ChangedFile>, right: ReadonlyArray<ChangedFile>): boolean =>
  left.length === right.length &&
  left.every((file, index) => {
    const candidate = right[index]
    return (
      candidate !== undefined &&
      file.path === candidate.path &&
      file.status === candidate.status &&
      file.added === candidate.added &&
      file.removed === candidate.removed
    )
  })

export const canSubmit = (model: Model): boolean =>
  model.editingTurnId === undefined &&
  !model.threadSwitcher.open &&
  !model.threadSidebar.focused &&
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
    case "Pasted": {
      const next = insertPaste(model, message.text)
      return model.shortcutsOpen ? continueShortcutsAfterEdit(model, next) : next
    }
    case "ImageInserted":
      return insertImage(model, message.path)
    case "ImageRemoved":
      return removeImage(model, message.path)
    case "PastedTextExpanded":
      return expandPastedTextAttachment(model, message.token)
    case "ThreadsReplaced": {
      const selectedId = (model.threads as ReadonlyArray<ThreadItem>)[model.threadSidebar.selected]?.id
      const browserSelectedId = selectedThreadMetadata(model)?.id
      const selected = Math.max(
        0,
        selectedId === undefined ? 0 : message.threads.findIndex((thread) => thread.id === selectedId),
      )
      const boundedSelected = Math.min(selected, Math.max(0, message.threads.length - 1))
      const maximumScrollTop = Math.max(0, message.threads.length - model.height)
      const boundedScrollTop = Math.min(model.threadSidebar.scrollTop, maximumScrollTop)
      const replacedThreads = {
        ...model,
        threads: [...message.threads],
        threadSidebar: {
          ...model.threadSidebar,
          selected: boundedSelected,
          scrollTop: Math.min(boundedScrollTop, boundedSelected),
        },
      }
      const browserThreads = filteredThreads(replacedThreads)
      const browserSelected = Math.max(
        0,
        browserSelectedId === undefined ? 0 : browserThreads.findIndex((thread) => thread.id === browserSelectedId),
      )
      const browserThread = browserThreads[browserSelected]
      const previewThreadId =
        model.threadPreview._tag === "Ready"
          ? model.threadPreview.value.threadId
          : model.threadPreview._tag === "Loading"
            ? model.threadPreview.previous?.threadId
            : undefined
      return {
        ...replacedThreads,
        threadSwitcher: {
          ...replacedThreads.threadSwitcher,
          selected: Math.min(browserSelected, Math.max(0, browserThreads.length - 1)),
          ...(browserThread?.id === previewThreadId ? {} : { previewScroll: 0 }),
        },
        ...(model.threadSwitcher.open && browserThread?.id !== previewThreadId ? { threadPreview: idle } : {}),
      }
    }
    case "ThreadActivated":
      return {
        ...model,
        currentThreadId: message.threadId,
        currentThreadTitle: message.title,
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
    case "FilesReplaced": {
      const replacedFiles = { ...model, filePicker: { ...model.filePicker, items: ready([...message.files]) } }
      return {
        ...replacedFiles,
        filePicker: {
          ...replacedFiles.filePicker,
          selected: Math.min(replacedFiles.filePicker.selected, Math.max(0, filteredFiles(replacedFiles).length - 1)),
        },
      }
    }
    case "BranchDetected":
      return { ...model, branch: message.branch }
    case "WorkspaceFilesToggled":
      return { ...model, workspaceFilesOpen: !model.workspaceFilesOpen, changedFilesOpen: false }
    case "ThreadSidebarSelectionMoved": {
      const selected = Math.max(0, Math.min(model.threads.length - 1, model.threadSidebar.selected + message.offset))
      const scrollTop =
        selected < model.threadSidebar.scrollTop
          ? selected
          : selected >= model.threadSidebar.scrollTop + model.height
            ? selected - model.height + 1
            : model.threadSidebar.scrollTop
      return { ...model, threadSidebar: { ...model.threadSidebar, selected, scrollTop } }
    }
    case "ThreadSidebarSelectionConfirmed": {
      const index = message.index ?? model.threadSidebar.selected
      const thread = (model.threads as ReadonlyArray<ThreadItem>)[index]
      return thread === undefined
        ? model
        : {
            ...model,
            threadSidebar: { ...model.threadSidebar, selected: index },
            pendingAction: { _tag: "SelectThread", id: thread.id },
          }
    }
    case "ThreadPreviewScrolled":
      return {
        ...model,
        threadSwitcher: {
          ...model.threadSwitcher,
          previewScroll: Math.max(0, model.threadSwitcher.previewScroll + message.offset),
        },
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
        permissionSelection: 0,
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
              id: message.event.id,
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
              id: message.event.id,
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
              id: message.event.id,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else {
          items.push({
            _tag: "Block",
            index: blocks.length,
            id: message.event.id,
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
          ...(model.busy
            ? {
                activity:
                  incoming._tag === "ToolCall"
                    ? { _tag: "RunningTools" as const }
                    : incoming._tag === "ToolResult" || incoming._tag === "Permission"
                      ? { _tag: "Waiting" as const }
                      : incoming._tag === "Reasoning"
                        ? streamActivity(model.activity, "Thinking", incoming.text, undefined)
                        : (model.activity ?? { _tag: "Waiting" as const }),
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
            activity: { _tag: "Sending" },
          }
    case "TurnStarted":
      if (model.entries.some((entry) => entry.role === "user" && entry.turnId === message.turnId))
        return { ...model, activeTurnId: message.turnId, busy: true, activity: { _tag: "Waiting" } }
      return {
        ...model,
        entries: [...model.entries, { role: "user", text: message.prompt, turnId: message.turnId }],
        items: [
          ...model.items,
          { _tag: "Entry", index: model.entries.length, id: `turn:${message.turnId}:user`, turnId: message.turnId },
        ],
        activeTurnId: message.turnId,
        busy: true,
        activity: { _tag: "Waiting" },
      }
    case "BlockAdded":
      return {
        ...model,
        blocks: [...model.blocks, message.block],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
        ...(model.busy
          ? {
              activity:
                message.block._tag === "ToolCall"
                  ? ({ _tag: "RunningTools" } as const)
                  : message.block._tag === "ToolResult" || message.block._tag === "Permission"
                    ? ({ _tag: "Waiting" } as const)
                    : (model.activity ?? ({ _tag: "Waiting" } as const)),
            }
          : {}),
      }
    case "ReasoningStreamed": {
      const blocks = [...model.blocks] as Array<TranscriptBlock>
      const lastItem = model.items.at(-1) as TranscriptItem | undefined
      const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
      if (last?._tag === "Reasoning" && lastItem?._tag === "Block")
        blocks[lastItem.index] = { ...last, text: last.text + message.text }
      else {
        blocks.push({ _tag: "Reasoning", text: message.text })
        return {
          ...model,
          blocks,
          items: [...model.items, { _tag: "Block", index: model.blocks.length }],
          ...(model.busy ? { activity: streamActivity(model.activity, "Thinking", message.text, undefined) } : {}),
        }
      }
      return {
        ...model,
        blocks,
        ...(model.busy ? { activity: streamActivity(model.activity, "Thinking", message.text, undefined) } : {}),
      }
    }
    case "ReasoningToggled": {
      const unit = transcriptUnits(model).find(
        (candidate) => candidate.kind === "reasoning" && candidate.block === message.index,
      )
      if (unit === undefined) return model
      const id = transcriptUnitId(model, unit)
      const expanded = new Set(model.expandedRowKeys)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return { ...model, expandedRowKeys: [...expanded] }
    }
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
        (message.turnId !== undefined || model.activity?._tag === "Streaming")
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
                  ...(message.id === undefined ? {} : { id: message.id }),
                  ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
                } as const,
              ],
        busy: true,
        activity: streamActivity(model.activity, "Streaming", message.text, undefined),
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
        (message.turnId !== undefined || model.activity?._tag === "Streaming")
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
            : [
                ...model.items,
                {
                  _tag: "Entry",
                  index: entries.length - 1,
                  ...(message.id === undefined ? {} : { id: message.id }),
                  turnId: message.turnId,
                },
              ],
        busy: model.busy,
        activity: model.busy && model.activeTurnId !== undefined ? { _tag: "Waiting" } : undefined,
      }
    }
    case "ExecutionCompleted":
      return message.turnId !== undefined && model.activeTurnId !== message.turnId
        ? model
        : { ...model, busy: false, activity: undefined, activeTurnId: undefined }
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
        activity: undefined,
        activeTurnId: undefined,
      }
    case "ExecutionCancelled":
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      if (!model.busy) return model
      {
        const turnId = message.turnId ?? model.activeTurnId
        const hasMarkerUnit = model.blocks.some((candidate) => {
          const block = candidate as TranscriptBlock
          if (block._tag === "ChildAgent") return block.status === "running" || block.status === "cancelled"
          return (
            block._tag === "ToolCall" &&
            (block.status === "running" || block.status === "cancelled") &&
            block.presentation.family === "agent"
          )
        })
        const entries = hasMarkerUnit
          ? model.entries
          : [
              ...model.entries,
              { role: "notice" as const, text: "cancelled", ...(turnId === undefined ? {} : { turnId }) },
            ]
        const items = hasMarkerUnit
          ? model.items
          : [
              ...model.items,
              {
                _tag: "Entry" as const,
                index: model.entries.length,
                ...(turnId === undefined ? {} : { id: `execution:${turnId}:cancelled`, turnId }),
              },
            ]
        return {
          ...model,
          entries,
          items,
          blocks: model.blocks.map((candidate) => {
            const block = candidate as TranscriptBlock
            return (block._tag === "ToolCall" || block._tag === "ChildAgent") && block.status === "running"
              ? { ...block, status: "cancelled" as const }
              : candidate
          }),
          busy: false,
          activity: undefined,
          activeTurnId: undefined,
        }
      }
    case "UsageReported":
      return message.costUsd === undefined ? model : { ...model, costUsd: (model.costUsd ?? 0) + message.costUsd }
    case "DetailMoved": {
      const ids = expandableRowIds(model)
      const count = ids.length
      if (count === 0) return model
      const current = ids.indexOf(model.detailSelection ?? "")
      const nextIndex =
        current < 0 ? (message.offset < 0 ? count - 1 : 0) : (((current + message.offset) % count) + count) % count
      return { ...model, detailSelection: ids[nextIndex]! }
    }
    case "DetailToggled": {
      const id = message.id ?? model.detailSelection
      if (id === undefined) return model
      if (!expandableRowIds(model).includes(id)) return model
      const expanded = new Set(model.expandedRowKeys)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return {
        ...model,
        detailSelection: message.id === undefined ? id : model.detailSelection,
        expandedRowKeys: [...expanded],
      }
    }
    case "AllDetailsToggled": {
      const roots = expandableRowIds({ ...model, expandedRowKeys: [] })
      if (roots.length === 0) return model
      const all = expandableRowIds({ ...model, expandedRowKeys: roots })
      const expanded = new Set(model.expandedRowKeys)
      return { ...model, expandedRowKeys: all.every((id) => expanded.has(id)) ? [] : [...all] }
    }
    case "FastModeToggled":
      return { ...model, fastMode: !model.fastMode }
    case "SidebarViewToggled":
      return { ...model, changedFilesOpen: !model.changedFilesOpen, workspaceFilesOpen: false }
    case "ChangedFilesRequested":
      return model.changedFiles._tag === "Ready" ? model : { ...model, changedFiles: loading }
    case "ChangedFilesReplaced": {
      if (model.changedFiles._tag === "Ready" && sameChangedFiles(model.changedFiles.value, message.files)) return model
      return { ...model, changedFiles: ready([...message.files]) }
    }
    case "ThreadPreviewRequested": {
      const previous =
        model.threadPreview._tag === "Ready"
          ? model.threadPreview.value
          : model.threadPreview._tag === "Loading"
            ? model.threadPreview.previous
            : undefined
      return {
        ...model,
        threadPreview: { _tag: "Loading", ...(previous === undefined ? {} : { previous }) },
        threadSwitcher: { ...model.threadSwitcher, previewScroll: 0 },
      }
    }
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
    case "ComposerReplaced":
      return {
        ...model,
        input: message.text,
        cursor: message.text.length,
        pastedText: [],
        shortcutsOpen: false,
        shortcutsTrigger: undefined,
      }
    case "KeyPressed": {
      const key = message.key
      if (key.eventType === "release") return model
      if (model.editingTurnId !== undefined) {
        if (key.name === "escape") {
          const restore = model.editReturn ?? { input: "", attachments: [] }
          return {
            ...model,
            editingTurnId: undefined,
            editReturn: undefined,
            queueSelection: undefined,
            input: restore.input,
            cursor: restore.input.length,
            pastedText: [...restore.attachments],
          }
        }
        if (key.name === "return" && !key.shift && !(model.cursor > 0 && model.input[model.cursor - 1] === "\\"))
          return {
            ...model,
            pendingAction: {
              _tag: "EditQueued",
              id: model.editingTurnId,
              prompt: expandPastedText(model.input, model.pastedText),
            },
            editingTurnId: undefined,
            editReturn: undefined,
            input: "",
            cursor: 0,
            pastedText: [],
          }
      }
      if (key.ctrl && (key.name === "\\" || key.sequence === "\u001c")) {
        const currentIndex = Math.max(
          0,
          (model.threads as ReadonlyArray<ThreadItem>).findIndex((thread) => thread.id === model.currentThreadId),
        )
        return model.threadSidebar.open
          ? model.threadSidebar.focused
            ? { ...model, threadSidebar: { ...model.threadSidebar, open: false, focused: false } }
            : { ...model, threadSidebar: { ...model.threadSidebar, focused: true } }
          : {
              ...model,
              threadSidebar: {
                open: true,
                focused: false,
                selected: currentIndex,
                scrollTop: Math.max(0, currentIndex - model.height + 1),
              },
            }
      }
      if (model.threadSidebar.open && model.threadSidebar.focused) {
        if (key.name === "escape") return { ...model, threadSidebar: { ...model.threadSidebar, focused: false } }
        if (key.name === "up") return update(model, { _tag: "ThreadSidebarSelectionMoved", offset: -1 })
        if (key.name === "down") return update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 1 })
        if (key.name === "return") return update(model, { _tag: "ThreadSidebarSelectionConfirmed" })
        return model
      }
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
        const selected = Math.max(
          0,
          filteredThreads({ ...model, threadSwitcher: { ...model.threadSwitcher, query: "" } }).findIndex(
            (thread) => thread.id === model.currentThreadId,
          ),
        )
        return {
          ...model,
          threadSwitcher: { open, query: "", selected, kind: "switch", previewScroll: 0 },
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false },
          shortcutsOpen: false,
          ...(open ? {} : { threadPreview: idle }),
        }
      }
      if (model.threadSwitcher.open) {
        const threads = filteredThreads(model)
        if (key.name === "escape")
          return {
            ...model,
            threadSwitcher: { open: false, query: "", selected: 0, kind: "switch", previewScroll: 0 },
            threadPreview: idle,
          }
        if (key.name === "return") {
          const thread = threads[model.threadSwitcher.selected]
          return thread === undefined
            ? model
            : model.threadSwitcher.kind === "mention"
              ? insert(
                  erase(
                    {
                      ...model,
                      threadSwitcher: {
                        open: false,
                        query: "",
                        selected: 0,
                        kind: "switch",
                        previewScroll: 0,
                      },
                      threadPreview: idle,
                    },
                    Math.min(2 + model.threadSwitcher.query.length, model.cursor),
                  ),
                  `@${thread.id} `,
                )
              : {
                  ...model,
                  threadSwitcher: {
                    open: false,
                    query: "",
                    selected: 0,
                    kind: "switch",
                    previewScroll: 0,
                  },
                  threadPreview: idle,
                  pendingAction: { _tag: "SelectThread", id: thread.id },
                }
        }
        if (key.name === "backspace") {
          if (model.threadSwitcher.kind === "mention" && model.threadSwitcher.query.length === 0)
            return erase(
              {
                ...model,
                threadSwitcher: {
                  open: false,
                  query: "",
                  selected: 0,
                  kind: "switch",
                  previewScroll: 0,
                },
                filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
              },
              1,
            )
          const next = {
            ...model,
            threadSwitcher: {
              ...model.threadSwitcher,
              query: model.threadSwitcher.query.slice(0, -lastCharacterLength(model.threadSwitcher.query)),
              selected: 0,
              previewScroll: 0,
            },
          }
          const restored =
            model.threadSwitcher.kind === "mention"
              ? erase(next, lastCharacterLength(model.threadSwitcher.query))
              : next
          return filteredThreads(restored).length === 0 ? { ...restored, threadPreview: idle } : restored
        }
        const selected =
          key.name === "up"
            ? (model.threadSwitcher.selected + Math.max(1, threads.length) - 1) % Math.max(1, threads.length)
            : key.name === "down"
              ? (model.threadSwitcher.selected + 1) % Math.max(1, threads.length)
              : model.threadSwitcher.selected
        if (!isPrintable(key))
          return {
            ...model,
            threadSwitcher: {
              ...model.threadSwitcher,
              selected,
              previewScroll: selected === model.threadSwitcher.selected ? model.threadSwitcher.previewScroll : 0,
            },
          }
        const next = {
          ...model,
          threadSwitcher: {
            ...model.threadSwitcher,
            query: model.threadSwitcher.query + key.sequence,
            selected: 0,
            previewScroll: 0,
          },
        }
        const filtered = model.threadSwitcher.kind === "mention" ? insert(next, key.sequence) : next
        return filteredThreads(filtered).length === 0 ? { ...filtered, threadPreview: idle } : filtered
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
            filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
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
      if (key.ctrl && key.name === "c" && model.busy)
        return { ...model, activity: { _tag: "Waiting" }, pendingAction: { _tag: "Cancel" } }
      if (key.ctrl && key.name === "s" && model.busy && model.input.length > 0)
        return { ...model, pendingAction: { _tag: "Steer", prompt: model.input }, input: "", cursor: 0 }
      if (key.ctrl && key.name === "return" && model.busy && model.input.length > 0)
        return { ...model, pendingAction: { _tag: "InterruptAndSend", prompt: model.input }, input: "", cursor: 0 }
      if (key.alt && key.name === "t") {
        return update(model, { _tag: "WorkspaceFilesToggled" })
      }
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
          filePicker: { ...model.filePicker, open: false, query: "", selected: 0 },
          shortcutsOpen: false,
          shortcutsTrigger: undefined,
        }
      if (model.shortcutsOpen) {
        if (questionKey(key)) return { ...model, shortcutsOpen: false, shortcutsTrigger: undefined }
        if (isPrintable(key)) return insertWhileShortcutsOpen(model, key.sequence)
        const next = update(
          { ...model, shortcutsOpen: false, shortcutsTrigger: undefined },
          { _tag: "KeyPressed", key },
        )
        return continueShortcutsAfterEdit(model, next)
      }
      if (model.modePicker.open) {
        const selected =
          key.name === "left" || key.name === "up"
            ? (model.modePicker.selected + 3) % 4
            : key.name === "right" || key.name === "down"
              ? (model.modePicker.selected + 1) % 4
              : model.modePicker.selected
        if (key.name === "return")
          return {
            ...model,
            mode: (["low", "medium", "high", "ultra"] as const)[selected]!,
            modePicker: { open: false, selected },
          }
        return { ...model, modePicker: { open: true, selected } }
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
              threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
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
        const mentionLength = Math.min(1 + model.filePicker.query.length, model.cursor)
        if (isPrintable(key) && key.sequence === "@" && model.filePicker.query === "")
          return insert(
            {
              ...model,
              filePicker: { ...model.filePicker, open: false },
              threadSwitcher: { open: true, query: "", selected: 0, kind: "mention", previewScroll: 0 },
            },
            "@",
          )
        const files = filteredFiles(model)
        const selected =
          key.name === "up"
            ? (model.filePicker.selected + Math.max(1, files.length) - 1) % Math.max(1, files.length)
            : key.name === "down"
              ? (model.filePicker.selected + 1) % Math.max(1, files.length)
              : model.filePicker.selected
        if (key.name === "return") {
          const file = files[selected]
          return file === undefined
            ? { ...model, filePicker: { ...model.filePicker, open: false } }
            : insert(
                erase(
                  { ...model, filePicker: { ...model.filePicker, open: false, query: "", selected: 0 } },
                  mentionLength,
                ),
                fileMention(file),
              )
        }
        if (key.name === "backspace") {
          if (model.filePicker.query.length > 0)
            return erase(
              {
                ...model,
                filePicker: {
                  ...model.filePicker,
                  query: model.filePicker.query.slice(0, -lastCharacterLength(model.filePicker.query)),
                  selected: 0,
                },
              },
              lastCharacterLength(model.filePicker.query),
            )
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
        if (questionKey(key)) return model
      }
      if (questionKey(key) && model.input.length === 0) {
        const trigger = model.cursor
        const next = insert(model, "?")
        return {
          ...next,
          shortcutsOpen: true,
          shortcutsTrigger: trigger,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false },
        }
      }
      if ((key.name === "tab" || key.name === "backtab") && !key.ctrl && !key.alt && !key.meta)
        return update(model, { _tag: "DetailMoved", offset: key.name === "backtab" || key.shift ? -1 : 1 })
      if (
        key.name === "return" &&
        !key.ctrl &&
        !key.alt &&
        !key.meta &&
        !key.shift &&
        model.input.length === 0 &&
        model.detailSelection !== undefined
      )
        return update(model, { _tag: "DetailToggled" })
      const queued = model.queue as ReadonlyArray<QueueItem>
      if (model.busy && model.input.length === 0 && queued.length > 0 && model.editingTurnId === undefined) {
        const current = queued.findIndex((item) => item.id === model.queueSelection)
        if (current < 0) {
          if (key.name === "up")
            return {
              ...model,
              queueSelection: queued.at(-1)!.id,
            }
        } else {
          if (key.name === "escape") return { ...model, queueSelection: undefined }
          if (key.name === "up") {
            const index = Math.max(0, current - 1)
            return {
              ...model,
              queueSelection: queued[index]!.id,
            }
          }
          if (key.name === "down") {
            if (current === queued.length - 1) return { ...model, queueSelection: undefined }
            return {
              ...model,
              queueSelection: queued[current + 1]!.id,
            }
          }
          const selected = queued[current]!
          if (key.ctrl && key.name === "e")
            return insert(
              {
                ...model,
                editingTurnId: selected.id,
                editReturn: { input: model.input, attachments: model.pastedText },
                input: "",
                cursor: 0,
                pastedText: [],
              },
              selected.prompt,
            )
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
