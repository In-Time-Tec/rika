import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Function, Schema } from "effect"
import { ModeId, modeIds } from "@rika/configuration/behavior-mode"
import {
  idle,
  ready as loadableReady,
  readyOr as loadableReadyOr,
  type Loadable,
  loadableSchemas,
} from "./terminal-loadable-state"
import { Activity } from "./terminal-activity-state"
import { UsageDisplay, UsageTime } from "./terminal-usage-state"
import * as ActivityState from "./terminal-activity-state"
import * as ComposerState from "./terminal-composer-state"
import * as LayoutState from "./terminal-layout-state"
import * as QueueState from "./terminal-queue-state"
import * as ThreadNavigation from "./terminal-thread-navigation"
import { update as reduceState } from "../reducer/terminal-state-reducer"
export { update } from "../reducer/terminal-state-reducer"
import * as KeysModule from "../../presentation/terminal/terminal-keymap"
import * as PaletteModule from "../../presentation/terminal/command-palette"
import * as TranscriptPresenterModule from "../../presentation/transcript/terminal-transcript-presentation"
import * as ExecutionEventsModule from "../../presentation/transcript/execution-event-presentation"
import * as SessionModule from "../../terminal-session"
import * as FormatModule from "../../presentation/terminal/terminal-format"
import * as ThemeModule from "../../presentation/terminal/terminal-theme"

export { idle, isLoading, isReady, loading, ready, readyOr } from "./terminal-loadable-state"
export type { Loadable } from "./terminal-loadable-state"
export type { Activity } from "./terminal-activity-state"
export type { UsageDisplay, UsageTime } from "./terminal-usage-state"
export type { ComposerAttachment, ComposerDraft, PendingSteering, PromptPart } from "./terminal-composer-state"

export const Mode = ModeId
export type Mode = typeof Mode.Type

export const Entry = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "notice"]),
  text: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
})
export type Entry = typeof Entry.Type

type TranscriptBlockModel = TranscriptPresentationModel.Block

interface ThreadItemModel {
  readonly id: string
  readonly title: string
  readonly workspace: string
  readonly pinned: boolean
  readonly archived: boolean
  readonly status: "idle" | "error" | "queued" | "running"
  readonly unread: boolean
  readonly lastActivityAt: number
  readonly editTotals?: { readonly added: number; readonly modified: number; readonly removed: number }
}

type TranscriptItemModel =
  | {
      readonly _tag: "Entry"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly rootTurnId?: string
      readonly parentId?: string
      readonly order?: TranscriptUnit.UnitOrder
    }
  | {
      readonly _tag: "Block"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly rootTurnId?: string
      readonly parentId?: string
      readonly order?: TranscriptUnit.UnitOrder
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
  readonly error?: string
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

const WorkspaceFilesSchema = Schema.Union([
  loadableSchemas.idle,
  loadableSchemas.loading,
  Schema.TaggedStruct("Ready", { value: Schema.Array(Schema.String) }),
])
const PaletteStateSchema = Schema.Struct({ open: Schema.Boolean, query: Schema.String, selected: Schema.Finite })
const ModePickerStateSchema = Schema.Struct({ open: Schema.Boolean, selected: Schema.Finite })
const ModeRouteLabelSchema = Schema.Struct({ name: Schema.String, effort: Schema.String, fast: Schema.Boolean })
const ModeRoutesSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ main: ModeRouteLabelSchema, oracle: ModeRouteLabelSchema }),
)
export type ModeRouteLabel = typeof ModeRouteLabelSchema.Type
export type ModeRoutes = typeof ModeRoutesSchema.Type
const modeLabel = (route: { readonly displayName: string; readonly effort: string; readonly fast: boolean }) =>
  ({ name: route.displayName, effort: route.effort, fast: route.fast }) satisfies ModeRouteLabel
export const defaultModeRoutes: ModeRoutes = Object.fromEntries(
  modeIds.map((mode) => [
    mode,
    {
      main: modeLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "main")),
      oracle: modeLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "oracle")),
    },
  ]),
)
const FilePickerStateSchema = Schema.Struct({
  open: Schema.Boolean,
  query: Schema.String,
  selected: Schema.Finite,
  items: WorkspaceFilesSchema,
  error: Schema.optional(Schema.String),
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
  loadableSchemas.idle,
  loadableSchemas.loading,
  Schema.TaggedStruct("Ready", { value: Schema.Array(ChangedFile) }),
])
const ThreadPreviewValueSchema = Schema.Struct({
  threadId: Schema.String,
  turns: Schema.Array(Schema.Struct({ prompt: Schema.String, units: Schema.Array(TranscriptUnit.Unit) })),
})
const ThreadPreviewSchema = Schema.Union([
  loadableSchemas.idle,
  Schema.TaggedStruct("Loading", { previous: Schema.optionalKey(ThreadPreviewValueSchema) }),
  Schema.TaggedStruct("Ready", { value: ThreadPreviewValueSchema }),
])
export const QueueItem = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
  provisional: Schema.optionalKey(Schema.Literal(true)),
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
  modeRoutes: ModeRoutesSchema,
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
  submittedDrafts: Schema.Array(
    Schema.Struct({
      input: Schema.String,
      attachments: Schema.Array(PastedTextAttachmentSchema),
      cursor: Schema.Finite,
      submissionId: Schema.optionalKey(Schema.String),
      turnId: Schema.optionalKey(Schema.String),
    }),
  ),
  pendingSteering: Schema.Array(
    Schema.Struct({
      turnId: Schema.String,
      text: Schema.String,
      sequence: Schema.optionalKey(Schema.Finite),
    }),
  ),
  cancelPending: Schema.Boolean,
  busy: Schema.Boolean,
  activity: Schema.optional(Activity),
  costUsd: Schema.optional(Schema.Finite),
  usageDisplay: Schema.optional(UsageDisplay),
  usageTime: Schema.optional(UsageTime),
  usageTokens: Schema.optional(
    Schema.Union([
      Schema.Struct({ _tag: Schema.tag("Loading") }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
      Schema.Struct({ _tag: Schema.tag("Available"), total: Schema.Finite, uncountedAttempts: Schema.Int }),
    ]),
  ),
  usageCost: Schema.optional(
    Schema.Union([
      Schema.Struct({ _tag: Schema.tag("Loading") }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
      Schema.Struct({ _tag: Schema.tag("Available"), usd: Schema.Finite, unpricedAttempts: Schema.Int }),
    ]),
  ),
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
  childExecutionOutcomes: Schema.Record(Schema.String, Schema.Unknown),
  activeTurnId: Schema.optional(Schema.String),
  eventCursor: Schema.optional(Schema.String),
  currentThreadId: Schema.optional(Schema.String),
  currentThreadTitle: Schema.optional(Schema.String),
  fastMode: Schema.Boolean,
  changedFilesOpen: Schema.Boolean,
  changedFiles: ChangedFilesSchema,
  sidebarWidth: Schema.Finite,
  threadLoading: Schema.Boolean,
  refoldingThreadIds: Schema.Array(Schema.String),
  threadPreview: ThreadPreviewSchema,
})
export type Model = typeof Model.Type

const initialImpl: {
  (workspace: string, mode?: Mode): Model
  (mode?: Mode): (workspace: string) => Model
} = Function.dual(
  (args) => args.length > 1 || !Mode.literals.includes(args[0]),
  (workspace: string, mode: Mode = "medium"): Model => ({
    workspace,
    mode,
    modeRoutes: defaultModeRoutes,
    entries: [],
    blocks: [],
    items: [],
    input: "",
    cursor: 0,
    pastedText: [],
    history: [],
    historyComposers: [],
    historySearch: "",
    submittedDrafts: [],
    pendingSteering: [],
    cancelPending: false,
    busy: false,
    usageDisplay: "cost",
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
    queueSelection: undefined,
    queue: [],
    expandedRowKeys: [],
    seenEventIds: [],
    seenExecutionEventKeys: [],
    childExecutionOutcomes: {},
    activeTurnId: undefined,
    fastMode: false,
    changedFilesOpen: false,
    changedFiles: idle,
    sidebarWidth: 36,
    threadLoading: false,
    refoldingThreadIds: [],
    threadPreview: idle,
  }),
)

export const withModeRoutes: {
  (routes: ModeRoutes): (model: Model) => Model
  (model: Model, routes: ModeRoutes): Model
} = Function.dual(2, (model: Model, routes: ModeRoutes): Model => ({ ...model, modeRoutes: routes }))

const nextModeImpl = (mode: Mode): Mode => modeIds[(modeIds.indexOf(mode) + 1) % modeIds.length]!
const nextUsageDisplayImpl = (display: UsageDisplay | undefined): UsageDisplay => {
  if (display === undefined || display === "cost") return "tokens"
  if (display === "tokens") return "time"
  return "cost"
}
export const isThreadBusy = (status: ThreadItemModel["status"]): boolean => status !== "idle" && status !== "error"
export const formatActiveTime = ActivityState.formatActiveTime
const activeTimeAtImpl = ActivityState.activeTimeAt
export const activeTimeIcon = ActivityState.activeTimeIcon
const formatActivityImpl = ActivityState.formatActivity
const replaceQueueImpl = QueueState.replaceQueue
const resetQueueImpl = QueueState.resetQueue
const applyQueueDeltaImpl = QueueState.applyQueueDelta
const replaceTurnPromptImpl = QueueState.replaceTurnPrompt
const composerHeightImpl = LayoutState.composerHeight
const contentColumnWidthImpl = LayoutState.contentColumnWidth
const boundedThreadSidebarWidthImpl = LayoutState.boundedThreadSidebarWidth
const fileSidebarLayoutWidthImpl = LayoutState.fileSidebarLayoutWidth
const isNarrowImpl = LayoutState.isNarrow
const queueContentWidthImpl = LayoutState.queueContentWidth
const wrappedRowCountImpl = LayoutState.wrappedRowCount
const threadSidebarLayoutWidthImpl = LayoutState.threadSidebarLayoutWidth
const inputRowsImpl = LayoutState.inputRows
const filteredFilesImpl = ThreadNavigation.filteredFiles
const filteredThreadsImpl = ThreadNavigation.filteredThreads
const selectedThreadMetadataImpl = ThreadNavigation.selectedThreadMetadata
const displayInputImpl = ComposerState.displayInput
const expandPastedTextImpl = ComposerState.expandPastedText
const promptPartsImpl = ComposerState.promptParts
const pastedTextTokenAtImpl = ComposerState.pastedTextTokenAt

const initialModel = initialImpl
const updateModel = reduceState

export { initialImpl as initial }
export { nextModeImpl as nextMode }
export { nextUsageDisplayImpl as nextUsageDisplay }
export { activeTimeAtImpl as activeTimeAt }
export { formatActivityImpl as formatActivity }
export { replaceQueueImpl as replaceQueue }
export { resetQueueImpl as resetQueue }
export { applyQueueDeltaImpl as applyQueueDelta }
export { replaceTurnPromptImpl as replaceTurnPrompt }
export { composerHeightImpl as composerHeight }
export { contentColumnWidthImpl as contentColumnWidth }
export { boundedThreadSidebarWidthImpl as boundedThreadSidebarWidth }
export { fileSidebarLayoutWidthImpl as fileSidebarLayoutWidth }
export { isNarrowImpl as isNarrow }
export { queueContentWidthImpl as queueContentWidth }
export { wrappedRowCountImpl as wrappedRowCount }
export { threadSidebarLayoutWidthImpl as threadSidebarLayoutWidth }
export { inputRowsImpl as inputRows }
export { filteredFilesImpl as filteredFiles }
export { filteredThreadsImpl as filteredThreads }
export { selectedThreadMetadataImpl as selectedThreadMetadata }
export { displayInputImpl as displayInput }
export { expandPastedTextImpl as expandPastedText }
export { promptPartsImpl as promptParts }
export { pastedTextTokenAtImpl as pastedTextTokenAt }

export type {
  TranscriptBlockModel as TranscriptBlock,
  TranscriptItemModel as TranscriptItem,
  ThreadItemModel as ThreadItem,
}
namespace ViewStateExports {
  export type Model = typeof Model.Type
  export type Mode = typeof Mode.Type
  export type Entry = typeof Entry.Type
  export type TranscriptBlock = import("./terminal-state").TranscriptBlock
  export type TranscriptItem = import("./terminal-state").TranscriptItem
  export type PromptPart = import("./terminal-composer-state").PromptPart
  export type ComposerAttachment = import("./terminal-composer-state").ComposerAttachment
  export type ThreadItem = import("./terminal-state").ThreadItem
  export const initial = (workspace: string, mode?: Mode): Model => initialModel(workspace, mode)
  export const update = (model: Model, message: import("../model/terminal-message").Message): Model =>
    updateModel(model, message)
  export const replaceQueue = QueueState.replaceQueue
  export const resetQueue = QueueState.resetQueue
  export const applyQueueDelta = QueueState.applyQueueDelta
  export const replaceTurnPrompt = QueueState.replaceTurnPrompt
  export const nextMode = (mode: Mode): Mode => modeIds[(modeIds.indexOf(mode) + 1) % modeIds.length]!
  export const nextUsageDisplay = (display: UsageDisplay | undefined): UsageDisplay => {
    if (display === undefined || display === "cost") return "tokens"
    if (display === "tokens") return "time"
    return "cost"
  }
  export const activeTimeAt = ActivityState.activeTimeAt
  export const formatActivity = ActivityState.formatActivity
  export const formatActivityCounter = ActivityState.formatActivityCounter
  export const runningToolsActivity = ActivityState.runningToolsActivity
  export const classifyPrompt = ComposerState.classifyPrompt
  export const wrappedRowCount = LayoutState.wrappedRowCount
  export const ready = loadableReady
  export const canSubmit = (model: Model): boolean =>
    model.editingTurnId === undefined &&
    !model.threadSwitcher.open &&
    !model.threadSidebar.focused &&
    !model.paletteOpen &&
    !model.palette.open &&
    !model.modePicker.open &&
    !model.filePicker.open &&
    !model.shortcutsOpen &&
    !(model.cursor > 0 && model.input[model.cursor - 1] === "\\")
  export const inputRows = LayoutState.inputRows
  export const composerHeight = LayoutState.composerHeight
  export const isNarrow = LayoutState.isNarrow
  export const readyOr = loadableReadyOr
  export const filteredThreads = ThreadNavigation.filteredThreads
  export const filteredFiles = ThreadNavigation.filteredFiles
  export const selectedThreadMetadata = ThreadNavigation.selectedThreadMetadata
  export const boundedThreadSidebarWidth = LayoutState.boundedThreadSidebarWidth
  export const threadSidebarLayoutWidth = LayoutState.threadSidebarLayoutWidth
  export const fileSidebarLayoutWidth = LayoutState.fileSidebarLayoutWidth
  export const contentColumnWidth = LayoutState.contentColumnWidth
  export const queueContentWidth = LayoutState.queueContentWidth
  export const displayInput = ComposerState.displayInput
  export const expandPastedText = ComposerState.expandPastedText
  export const promptParts = ComposerState.promptParts
  export const pastedTextTokenAt = ComposerState.pastedTextTokenAt
}
export namespace Keys {
  export type Key = KeysModule.Key
  export const fromOpenTui = KeysModule.fromOpenTui
  export const isPrintable = KeysModule.isPrintable
}
export namespace Palette {
  export type PaletteAction = PaletteModule.PaletteAction
  export const filter = PaletteModule.filter
  export const commands = PaletteModule.commands
}
export namespace Theme {
  export const colors = ThemeModule.colors
  export const spacing = ThemeModule.spacing
}
export namespace Format {
  export const formatTokens = FormatModule.formatTokens
  export const homeRelativePath = FormatModule.homeRelativePath
}
export namespace TranscriptPresenter {
  export const applyTurnUnits = TranscriptPresenterModule.applyTurnUnits
  export const applyTurnDelta = TranscriptPresenterModule.applyTurnDelta
  export const applyRootUnits = TranscriptPresenterModule.applyRootUnits
  export const applyChildUnits = TranscriptPresenterModule.applyChildUnits
  export const attachChildProjections = TranscriptPresenterModule.attachChildProjections
  export const emptyAttachments = TranscriptPresenterModule.emptyAttachments
  export const rows = TranscriptPresenterModule.rows
  export const unitId = TranscriptPresenterModule.unitId
  export const expandableRowIds = TranscriptPresenterModule.expandableRowIds
  export const pinnedRowWindow = TranscriptPresenterModule.pinnedRowWindow
  export const resolveRowEnd = TranscriptPresenterModule.resolveRowEnd
  export const shiftRowEnd = TranscriptPresenterModule.shiftRowEnd
  export const relocateRowEnd = TranscriptPresenterModule.relocateRowEnd
  export const includeRowEnd = TranscriptPresenterModule.includeRowEnd
}
export namespace ExecutionEvents {
  export const projectUnits = ExecutionEventsModule.projectUnits
  export const projectChildUnits = ExecutionEventsModule.projectChildUnits
}
export namespace Session {
  export type Action = SessionModule.Action
  export type Adapter = SessionModule.Adapter
  export const execute = SessionModule.execute
}

export { ViewStateExports as ViewState }
