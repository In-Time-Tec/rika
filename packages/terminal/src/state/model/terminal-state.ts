import { Function, Schema } from "effect"
import { ModeId } from "@rika/config/behavior-mode"
import { idle as loadableIdle, loadableSchemas } from "./terminal-loadable-state"
import { Activity } from "./terminal-activity-state"
import { UsageDisplay, UsageTime } from "./terminal-usage-state"
import { defaultModeRouteMap, modeRouteMapSchema, type ModeRouteMap } from "./terminal-mode-route"
import { ChangedFile as ChangedFileSchema } from "./terminal-changed-file"
import type { ChangedFile } from "./terminal-changed-file"
import type { ThreadItem } from "./terminal-thread-state"
import { QueueItem as QueueItemSchema } from "./terminal-queue-item"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Entry } from "./terminal-message"
import { ContextUsage } from "./terminal-context-usage"

export const Mode = ModeId
export type Mode = typeof Mode.Type
export type { ChangedFile, ThreadItem }
const WorkspaceFilesSchema = Schema.Union([
  loadableSchemas.idle,
  loadableSchemas.loading,
  Schema.TaggedStruct("Ready", { value: Schema.Array(Schema.String) }),
])
const PaletteStateSchema = Schema.Struct({ open: Schema.Boolean, query: Schema.String, selected: Schema.Finite })
const ModePickerStateSchema = Schema.Struct({
  open: Schema.Boolean,
  selected: Schema.Finite,
  from: Schema.optional(Schema.Finite),
  fromPosition: Schema.optional(Schema.Finite),
  turnTick: Schema.optional(Schema.Finite),
})
const ModeCommitAnimationSchema = Schema.Struct({ from: Mode, to: Mode, tick: Schema.Finite })
const ContextAnimationSchema = Schema.Struct({
  compactFromPercent: Schema.optional(Schema.Finite),
  compactTick: Schema.optional(Schema.Finite),
  compactionPending: Schema.optional(Schema.Boolean),
  flashTicks: Schema.Finite,
  flashed75: Schema.Boolean,
  flashed90: Schema.Boolean,
})
const CompactionShimmerSchema = Schema.Struct({ tick: Schema.Finite, remaining: Schema.Finite })
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
const ChangedFilesSchema = Schema.Union([
  loadableSchemas.idle,
  loadableSchemas.loading,
  Schema.TaggedStruct("Ready", { value: Schema.Array(ChangedFileSchema) }),
])
const ThreadPreviewValueSchema = Schema.Struct({
  threadId: Schema.String,
  turns: Schema.Array(Schema.Struct({ prompt: Schema.String, units: Schema.Array(TranscriptUnit.Unit) })),
})
const ThreadPreviewSchema = Schema.Union([
  loadableSchemas.idle,
  Schema.TaggedStruct("Loading", { previous: Schema.optionalKey(ThreadPreviewValueSchema) }),
  Schema.TaggedStruct("Ready", { value: ThreadPreviewValueSchema }),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
])
export const Model = Schema.Struct({
  workspace: Schema.String,
  branch: Schema.optional(Schema.String),
  mode: Mode,
  modeRoutes: modeRouteMapSchema,
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
  contextUsage: Schema.optional(ContextUsage),
  contextAnimation: ContextAnimationSchema,
  animationTick: Schema.Finite,
  retryCountdown: Schema.Finite,
  compactionShimmer: Schema.optional(CompactionShimmerSchema),
  contextDetailsOpen: Schema.Boolean,
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
  modeCommit: Schema.optional(ModeCommitAnimationSchema),
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
  queue: Schema.Array(QueueItemSchema),
  queueThreadId: Schema.optional(Schema.String),
  queueRevision: Schema.optional(Schema.Int),
  editingTurnId: Schema.optional(Schema.String),
  editReturn: Schema.optional(ComposerDraftSchema),
  detailSelection: Schema.optional(Schema.String),
  expandedRowKeys: Schema.Array(Schema.String),
  seenEventIds: Schema.Array(Schema.String),
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
    modeRoutes: defaultModeRouteMap,
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
    contextUsage: { _tag: "Loading" },
    contextAnimation: { flashTicks: 0, flashed75: false, flashed90: false },
    animationTick: 0,
    retryCountdown: 0,
    compactionShimmer: undefined,
    contextDetailsOpen: false,
    usageDisplay: "cost",
    paletteOpen: false,
    palette: { open: false, query: "", selected: 0 },
    modePicker: { open: false, selected: 0 },
    modeCommit: undefined,
    filePicker: { open: false, query: "", selected: 0, items: loadableIdle },
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
    childExecutionOutcomes: {},
    activeTurnId: undefined,
    fastMode: false,
    changedFilesOpen: false,
    changedFiles: loadableIdle,
    sidebarWidth: 52,
    threadLoading: false,
    refoldingThreadIds: [],
    threadPreview: loadableIdle,
  }),
)
export const withModeRouteMap: {
  (routes: ModeRouteMap): (model: Model) => Model
  (model: Model, routes: ModeRouteMap): Model
} = Function.dual(2, (model: Model, routes: ModeRouteMap): Model => ({ ...model, modeRoutes: routes }))
const initialPublicImpl = (workspace: string, mode: Mode = "medium"): Model => initialImpl(workspace, mode)

export const initial: {
  (
    arg0: Parameters<typeof initialPublicImpl>[0],
    arg1?: Parameters<typeof initialPublicImpl>[1],
  ): ReturnType<typeof initialPublicImpl>
  (
    arg1?: Parameters<typeof initialPublicImpl>[1],
  ): (arg0: Parameters<typeof initialPublicImpl>[0]) => ReturnType<typeof initialPublicImpl>
} = Function.dual((args) => args.length >= 1 && typeof args[0] === "string", initialPublicImpl)
