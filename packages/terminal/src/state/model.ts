import { Function, Schema } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { idle as loadableIdle, loadableSchemas } from "./loadable"
import { Activity } from "./activity/model"
import { UsageDisplay, UsageTime } from "./usage"
import { defaultModeRouteMap, modeRouteMapSchema, type ModeRouteMap } from "./mode/route"
import { ChangedFile as ChangedFileSchema } from "./changed-file"
import type { ChangedFile } from "./changed-file"
import { ThreadItem } from "./thread/model"
import { QueueItem as QueueItemSchema } from "./queue/item"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Entry } from "./message"
import { ContextUsage } from "./context/usage"
import { GoalIndicator } from "./goal"

export const Mode = ModeId
export type Mode = typeof Mode.Type
export type { ChangedFile, ThreadItem }
const WorkspaceFilesSchema = Schema.Union([
  loadableSchemas.idle,
  loadableSchemas.loading,
  Schema.TaggedStruct("Ready", { value: Schema.Array(Schema.String) }),
])
const PaletteStateSchema = Schema.Struct({
  open: Schema.Boolean,
  query: Schema.String,
  selected: Schema.Finite,
  limit: Schema.optional(Schema.Literals(["maxDepth", "maxSubagents"])),
})
const ModePickerStateSchema = Schema.Struct({
  open: Schema.Boolean,
  selected: Schema.Finite,
  from: Schema.optional(Schema.Finite),
  fromPosition: Schema.optional(Schema.Finite),
  turnTick: Schema.optional(Schema.Finite),
})
const ModeCommitAnimationSchema = Schema.Struct({ from: Mode, to: Mode, tick: Schema.Finite })
const ContextAnimationSchema = Schema.Struct({
  munchTick: Schema.Finite,
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
  requestId: Schema.Int,
  units: Schema.Array(TranscriptUnit.Unit),
})
const ThreadPreviewSchema = Schema.Union([
  loadableSchemas.idle,
  Schema.TaggedStruct("Loading", { threadId: Schema.String, requestId: Schema.Int }),
  Schema.TaggedStruct("Ready", { value: ThreadPreviewValueSchema }),
  Schema.TaggedStruct("Failed", { threadId: Schema.String, requestId: Schema.Int, message: Schema.String }),
])
export const ConnectionState = Schema.Struct({
  connectivity: Schema.Literals(["connecting", "connected", "reconnecting"]),
  target: Schema.Literals(["resolving", "runner", "orb"]),
  activity: Schema.optional(
    Schema.Literals([
      "authenticating",
      "executor-waiting",
      "executor-connected",
      "workspace-preparing",
      "workspace-failed",
      "approval-required",
      "unknown-operation",
      "terminal",
    ]),
  ),
  ownership: Schema.optional(Schema.Literals(["personal", "organization"])),
  participants: Schema.Int,
})
export type ConnectionState = typeof ConnectionState.Type
export const Model = Schema.Struct({
  workspace: Schema.String,
  branch: Schema.optional(Schema.String),
  mode: Mode,
  rememberedMode: Schema.optional(Mode),
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
      runId: Schema.String,
      requestId: Schema.String,
      turnId: Schema.String,
      text: Schema.String,
      entryId: Schema.String,
      sequence: Schema.Finite,
    }),
  ),
  steeringRequests: Schema.Array(
    Schema.Union([
      Schema.Struct({
        requestId: Schema.String,
        turnId: Schema.String,
        text: Schema.String,
        origin: Schema.Literal("composer"),
      }),
      Schema.Struct({
        requestId: Schema.String,
        turnId: Schema.String,
        text: Schema.String,
        origin: Schema.Literal("queue"),
        queuedTurnId: Schema.String,
      }),
    ]),
  ),
  cancelPending: Schema.Boolean,
  busy: Schema.Boolean,
  activity: Schema.optional(Activity),
  connection: Schema.optional(ConnectionState),
  contextUsage: Schema.optional(ContextUsage),
  goal: Schema.optional(GoalIndicator),
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
      Schema.Struct({ _tag: Schema.tag("Included"), includedAttempts: Schema.Int }),
      Schema.Struct({
        _tag: Schema.tag("Available"),
        usd: Schema.Finite,
        unpricedAttempts: Schema.Int,
        includedAttempts: Schema.Int,
      }),
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
  threads: Schema.Array(ThreadItem),
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
const initialImpl = (workspace: string, mode: Mode): Model => ({
  workspace,
  mode,
  modeRoutes: defaultModeRouteMap,
  rememberedMode: undefined,
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
  steeringRequests: [],
  cancelPending: false,
  busy: false,
  connection: undefined,
  contextUsage: { _tag: "Loading" },
  goal: undefined,
  contextAnimation: { munchTick: 0, flashTicks: 0, flashed75: false, flashed90: false },
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
  threadSwitcher: { open: false, query: "", selected: 0, kind: "switch" },
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
  threadPreview: { _tag: "Idle" },
})
export interface ModeConfiguration {
  readonly routes: ModeRouteMap
  readonly defaultMode: Mode
  readonly rememberedMode?: Mode
}
export const withModeConfiguration: {
  (configuration: ModeConfiguration): (model: Model) => Model
  (model: Model, configuration: ModeConfiguration): Model
} = Function.dual(
  2,
  (model: Model, configuration: ModeConfiguration): Model => ({
    ...model,
    modeRoutes: configuration.routes,
    rememberedMode:
      configuration.rememberedMode !== undefined && Object.hasOwn(configuration.routes, configuration.rememberedMode)
        ? configuration.rememberedMode
        : undefined,
  }),
)
export const initial = (
  ...[workspace, mode = SettingsDefaults.Defaults.defaults.defaultMode]: readonly [workspace: string, mode?: Mode]
): Model => initialImpl(workspace, mode)
