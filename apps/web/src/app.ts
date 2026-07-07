import { Common, Event, Ids, Message as RikaMessage, PierreDiff, Remote } from "@rika/schema"
import { Client } from "@rika/sdk"
import * as ModelInfo from "@rika/llm/model-info"
import { parsePatchFiles } from "@pierre/diffs"
import * as Command from "foldkit/command"
import { m } from "foldkit/message"
import * as Mount from "foldkit/mount"
import * as Subscription from "foldkit/subscription"
import { Duration, Effect, Option, Queue, Schedule, Schema as S, Stream } from "effect"
import * as AlertDialog from "./components/ui/alert-dialog"
import * as MessageScroller from "./components/ui/message-scroller-state"
import * as Tabs from "./components/ui/tabs-state"
import {
  asFileDiffMetadata,
  collectPierreDiffPayloads,
  mountPierreDiff,
  payloadFileName,
  toWebPierreDiffFromFileDiff,
  toWebPierreDiff,
  type WebPierreDiff,
} from "./pierre-diff"
import { mountPierreTree, pierreTreeRegistry, updatePierreTree } from "./pierre-tree"
import { mountOrbTerminal, orbTerminalRegistry, reconnectOrbTerminal } from "./orb-terminal"

export const Connection = S.Literals(["idle", "loading", "connected", "failed"])
export type Connection = typeof Connection.Type
export const OrbTab = S.Literals(["transcript", "files", "changes", "terminal"])
export type OrbTab = typeof OrbTab.Type

export const OrbTabItems: ReadonlyArray<Tabs.TabItem<OrbTab>> = [
  { value: "transcript", label: "Transcript" },
  { value: "files", label: "Files" },
  { value: "changes", label: "Changes" },
  { value: "terminal", label: "Terminal" },
]

export const OrbTabs = Tabs.create()

export const OrbDirectoryState = S.Union([
  S.Struct({ state: S.Literal("loading") }),
  S.Struct({ state: S.Literal("loaded") }),
  S.Struct({ state: S.Literal("failed"), message: S.String }),
])
export type OrbDirectoryState = typeof OrbDirectoryState.Type

export const OrbOpenedFile = S.Union([
  S.Struct({ state: S.Literal("idle") }),
  S.Struct({ state: S.Literal("loading"), path: S.String }),
  S.Struct({ state: S.Literal("text"), path: S.String, content: S.String, truncated: S.Boolean }),
  S.Struct({ state: S.Literal("binary"), path: S.String }),
  S.Struct({ state: S.Literal("failed"), path: S.String, message: S.String }),
])
export type OrbOpenedFile = typeof OrbOpenedFile.Type

export const PierreTreeGitStatus = S.Literals(["added", "deleted", "ignored", "modified", "renamed", "untracked"])
export type PierreTreeGitStatus = typeof PierreTreeGitStatus.Type

export const PierreTreeGitStatusEntry = S.Struct({
  path: S.String,
  status: PierreTreeGitStatus,
})
export type PierreTreeGitStatusEntry = typeof PierreTreeGitStatusEntry.Type

export const OrbFilesModel = S.Struct({
  directories: S.Record(S.String, OrbDirectoryState),
  paths: S.Array(S.String),
  path_kinds: S.Record(S.String, Remote.OrbFileKind),
  selected_path: S.optional(S.String),
  git_status: S.Array(PierreTreeGitStatusEntry),
  opened_file: OrbOpenedFile,
})
export type OrbFilesModel = typeof OrbFilesModel.Type

export const OrbChangeDiff = S.Struct({
  kind: S.Literal("diff"),
  payload_id: S.String,
  file_name: S.String,
  additions: S.Int,
  deletions: S.Int,
  file_diff: PierreDiff.FileDiffMetadata,
  git_status: PierreTreeGitStatusEntry,
})
export type OrbChangeDiff = typeof OrbChangeDiff.Type

export const OrbChangeSkipped = S.Struct({
  kind: S.Literal("skipped"),
  payload_id: S.String,
  file_name: S.String,
  reason: S.String,
  git_status: PierreTreeGitStatusEntry,
})
export type OrbChangeSkipped = typeof OrbChangeSkipped.Type

export const OrbChangeRow = S.Union([OrbChangeDiff, OrbChangeSkipped])
export type OrbChangeRow = typeof OrbChangeRow.Type

export const OrbChangesModel = S.Union([
  S.Struct({ state: S.Literal("idle") }),
  S.Struct({ state: S.Literal("loading") }),
  S.Struct({ state: S.Literal("failed"), message: S.String }),
  S.Struct({
    state: S.Literal("loaded"),
    base_commit: S.String,
    head_commit: S.String,
    dirty: S.Boolean,
    diffs: S.Array(OrbChangeRow),
  }),
])
export type OrbChangesModel = typeof OrbChangesModel.Type

export const OrbTerminalStatusSchema = S.Literals(["idle", "connecting", "connected", "disconnected", "failed"])
export const ActiveView = S.Literals(["threads", "projects"])
export type ActiveView = typeof ActiveView.Type
export const ThreadSearchWindow = S.Literals(["24h", "72h", "7d", "all"])
export type ThreadSearchWindow = typeof ThreadSearchWindow.Type
export const ProjectField = S.Literals(["name", "repo_origin", "default_branch", "template_id"])
export type ProjectField = typeof ProjectField.Type
export const ProjectSecretField = S.Literals(["name", "value"])
export type ProjectSecretField = typeof ProjectSecretField.Type

export const QueuedMessage = S.Struct({
  thread_id: Ids.ThreadId,
  content: S.String,
  mode: S.optional(Remote.AgentMode),
})
export type QueuedMessage = typeof QueuedMessage.Type

export const PendingStartTurn = S.Struct({
  thread_id: Ids.ThreadId,
  request_token: S.Int,
  content: S.String,
  mode: S.optional(Remote.AgentMode),
})
export type PendingStartTurn = typeof PendingStartTurn.Type

export const ProjectForm = S.Struct({
  name: S.String,
  repo_origin: S.String,
  default_branch: S.String,
  template_id: S.String,
  env: S.Record(S.String, S.String),
})
export type ProjectForm = typeof ProjectForm.Type

export const NewProjectForm = S.Struct({
  name: S.String,
  repo_origin: S.String,
  default_branch: S.String,
  template_id: S.String,
  env_key: S.String,
  env_value: S.String,
})
export type NewProjectForm = typeof NewProjectForm.Type

export const Model = S.Struct({
  api_base_url: S.String,
  active_view: ActiveView,
  connection: Connection,
  threads: S.Array(Remote.ThreadSummary),
  thread_search_query: S.String,
  thread_search_window: ThreadSearchWindow,
  projects: S.Array(Remote.ProjectSummary),
  selected_project_id: S.optional(Ids.ProjectId),
  selected_project: S.optional(Remote.ProjectDetail),
  project_form: ProjectForm,
  new_project_form: NewProjectForm,
  project_secret_name: S.String,
  project_secret_value: S.String,
  pending_secret_delete_name: S.optional(S.String),
  events: S.Array(Event.Event),
  last_sequence: S.Int,
  subscription_after_sequence: S.Int,
  subscription_retry: S.Int,
  draft: S.String,
  draft_mode: S.optional(Remote.AgentMode),
  pending_turn: S.Boolean,
  pending_interrupt_turn_id: S.optional(Ids.TurnId),
  queued_messages: S.Array(QueuedMessage),
  pending_start_turns: S.Array(PendingStartTurn),
  creating_thread: S.Boolean,
  thread_request_token: S.Int,
  active_thread_request_token: S.optional(S.Int),
  turn_request_token: S.Int,
  active_turn_request_token: S.optional(S.Int),
  selected_thread_id: S.optional(Ids.ThreadId),
  subscribed_thread_id: S.optional(Ids.ThreadId),
  selected_orb: S.optional(Remote.OrbSummary),
  selected_orb_tab: OrbTab,
  orb_tabs: Tabs.Model,
  transcript_scroller: MessageScroller.Model,
  kill_orb_dialog: AlertDialog.Model,
  orb_files: OrbFilesModel,
  orb_changes: OrbChangesModel,
  orb_terminal_status: OrbTerminalStatusSchema,
  orb_terminal_error: S.optional(S.String),
  expanded_diff_ids: S.Array(S.String),
  collapsed_transcript_row_ids: S.Array(S.String),
  confirm_kill_orb_id: S.optional(Ids.OrbId),
  delete_secret_dialog: AlertDialog.Model,
  backend: S.optional(Remote.BackendHealth),
  notice: S.optional(S.String),
  pending_submit: S.optional(S.String),
  pending_submit_mode: S.optional(Remote.AgentMode),
  user_id: S.optional(Ids.UserId),
  presence: S.Array(Remote.PresenceUser),
  typing_presence_cooling: S.Boolean,
})
export type Model = typeof Model.Type

export interface RuntimeConfig {
  readonly api_base_url: string
  readonly thread_id?: Ids.ThreadId
  readonly user_id?: Ids.UserId
}

export type TranscriptRow = TextTranscriptRow | PierreDiffTranscriptRow

export interface TextTranscriptRow {
  readonly id: string
  readonly sequence: number
  readonly kind: "message" | "event" | "tool" | "error"
  readonly title: string
  readonly body: string
  readonly is_open?: boolean
  readonly author?: {
    readonly label: string
    readonly is_local: boolean
  }
}

export interface PierreDiffTranscriptRow {
  readonly id: string
  readonly sequence: number
  readonly kind: "pierre-diff"
  readonly title: string
  readonly diff: WebPierreDiff
  readonly expanded: boolean
}

export type ContextUsageTone = "normal" | "warning" | "danger"

export interface ContextUsage {
  readonly tokens: number
  readonly window: number
  readonly percent: number
  readonly tone: ContextUsageTone
}

export const LoadedBackendHealth = m("LoadedBackendHealth", { health: Remote.BackendHealth })
export const FailedBackendHealth = m("FailedBackendHealth", { message: S.String })
export const LoadedThreads = m("LoadedThreads", { threads: S.Array(Remote.ThreadSummary) })
export const FailedLoadThreads = m("FailedLoadThreads", { message: S.String })
export const ChangedThreadSearchQuery = m("ChangedThreadSearchQuery", { value: S.String, now: Common.TimestampMillis })
export const ChangedThreadSearchWindow = m("ChangedThreadSearchWindow", {
  value: S.String,
  now: Common.TimestampMillis,
})
export const ClickedThread = m("ClickedThread", { thread_id: Ids.ThreadId })
export const ClickedNewThread = m("ClickedNewThread")
export const CreatedThread = m("CreatedThread", { summary: Remote.ThreadSummary, request_token: S.Int })
export const FailedCreateThread = m("FailedCreateThread", { message: S.String, request_token: S.Int })
export const OpenedThread = m("OpenedThread", { record: Remote.ThreadRecord, request_token: S.Int })
export const FailedOpenThread = m("FailedOpenThread", { message: S.String, request_token: S.Int })
export const LoadedSelectedOrb = m("LoadedSelectedOrb", { orb: Remote.OrbSummary })
export const FailedLoadSelectedOrb = m("FailedLoadSelectedOrb", { message: S.String })
export const GotOrbTabsMessage = m("GotOrbTabsMessage", { message: Tabs.Message })
export const GotTranscriptScrollerMessage = m("GotTranscriptScrollerMessage", { message: MessageScroller.Message })
export const GotKillOrbDialogMessage = m("GotKillOrbDialogMessage", { message: AlertDialog.Message })
export const ClickedPauseOrb = m("ClickedPauseOrb")
export const ClickedResumeOrb = m("ClickedResumeOrb")
export const ClickedKillOrb = m("ClickedKillOrb")
export const CancelledKillOrb = m("CancelledKillOrb")
export const ConfirmedKillOrb = m("ConfirmedKillOrb")
export const UpdatedSelectedOrb = m("UpdatedSelectedOrb", { orb: Remote.OrbSummary })
export const FailedOrbAction = m("FailedOrbAction", { message: S.String })
export const ClickedTranscriptDisclosure = m("ClickedTranscriptDisclosure", { row_id: S.String })
export const LoadedOrbDirectory = m("LoadedOrbDirectory", { response: Remote.OrbFilesResponse })
export const FailedLoadOrbDirectory = m("FailedLoadOrbDirectory", { path: S.String, message: S.String })
export const SelectedOrbFile = m("SelectedOrbFile", { path: S.String })
export const LoadedOrbFile = m("LoadedOrbFile", { response: Remote.OrbFileResponse })
export const FailedLoadOrbFile = m("FailedLoadOrbFile", { path: S.String, message: S.String })
export const LoadedOrbChanges = m("LoadedOrbChanges", { response: Remote.OrbChangesResponse })
export const FailedLoadOrbChanges = m("FailedLoadOrbChanges", { message: S.String })
export const ChangedDraft = m("ChangedDraft", { value: S.String })
export const ChangedDraftMode = m("ChangedDraftMode", { value: S.String })
export const SubmittedDraft = m("SubmittedDraft")
export const AcceptedTurn = m("AcceptedTurn", { response: Remote.StartTurnResponse, request_token: S.Int })
export const FailedStartTurn = m("FailedStartTurn", {
  thread_id: Ids.ThreadId,
  message: S.String,
  request_token: S.Int,
  status: S.optional(S.Int),
  active_user_id: S.optional(Ids.UserId),
})
export const TypingPresenceReady = m("TypingPresenceReady")
export const ClickedInterrupt = m("ClickedInterrupt")
export const InterruptedTurn = m("InterruptedTurn", { event: Event.TurnTerminal })
export const FailedInterruptTurn = m("FailedInterruptTurn", { message: S.String })
export const ReceivedThreadEvent = m("ReceivedThreadEvent", { event: Event.Event })
export const ReceivedPresence = m("ReceivedPresence", { presence: Remote.PresencePayload })
export const ThreadSubscriptionFailed = m("ThreadSubscriptionFailed", { message: S.String })
export const ClickedTogglePierreDiff = m("ClickedTogglePierreDiff", { payload_id: S.String })
export const RenderedPierreDiff = m("RenderedPierreDiff", { payload_id: S.String })
export const FailedRenderPierreDiff = m("FailedRenderPierreDiff", { payload_id: S.String, message: S.String })
export const RenderedPierreTree = m("RenderedPierreTree", { selected_path: S.optional(S.String) })
export const FailedRenderPierreTree = m("FailedRenderPierreTree", { message: S.String })
export const TerminalStatusChanged = m("TerminalStatusChanged", { status: OrbTerminalStatusSchema })
export const TerminalFailed = m("TerminalFailed", { message: S.String })
export const RequestedTerminalReconnect = m("RequestedTerminalReconnect")
export const ClickedThreads = m("ClickedThreads")
export const ClickedProjects = m("ClickedProjects")
export const LoadedProjects = m("LoadedProjects", { projects: S.Array(Remote.ProjectSummary) })
export const FailedLoadProjects = m("FailedLoadProjects", { message: S.String })
export const ClickedProject = m("ClickedProject", { project_id: Ids.ProjectId })
export const LoadedProject = m("LoadedProject", { project: Remote.ProjectDetail })
export const FailedLoadProject = m("FailedLoadProject", { message: S.String })
export const ChangedNewProjectField = m("ChangedNewProjectField", { field: ProjectField, value: S.String })
export const ChangedNewProjectEnvKey = m("ChangedNewProjectEnvKey", { value: S.String })
export const ChangedNewProjectEnvValue = m("ChangedNewProjectEnvValue", { value: S.String })
export const SubmittedNewProject = m("SubmittedNewProject")
export const ChangedProjectField = m("ChangedProjectField", { field: ProjectField, value: S.String })
export const ChangedProjectEnvValue = m("ChangedProjectEnvValue", { key: S.String, value: S.String })
export const RemovedProjectEnv = m("RemovedProjectEnv", { key: S.String })
export const SubmittedProjectSettings = m("SubmittedProjectSettings")
export const SavedProject = m("SavedProject", { project: Remote.ProjectDetail })
export const FailedSaveProject = m("FailedSaveProject", { message: S.String })
export const ChangedProjectSecretField = m("ChangedProjectSecretField", { field: ProjectSecretField, value: S.String })
export const SubmittedProjectSecret = m("SubmittedProjectSecret")
export const ClickedDeleteProjectSecret = m("ClickedDeleteProjectSecret", { name: S.String })
export const CancelledDeleteProjectSecret = m("CancelledDeleteProjectSecret")
export const ConfirmedDeleteProjectSecret = m("ConfirmedDeleteProjectSecret")
export const GotDeleteSecretDialogMessage = m("GotDeleteSecretDialogMessage", { message: AlertDialog.Message })

const BackendMessage = S.Union([
  LoadedBackendHealth,
  FailedBackendHealth,
  LoadedThreads,
  FailedLoadThreads,
  ChangedThreadSearchQuery,
  ChangedThreadSearchWindow,
  ClickedThread,
  ClickedNewThread,
  CreatedThread,
  FailedCreateThread,
  OpenedThread,
  FailedOpenThread,
])

const OrbControlMessage = S.Union([
  LoadedSelectedOrb,
  FailedLoadSelectedOrb,
  GotOrbTabsMessage,
  GotKillOrbDialogMessage,
  ClickedPauseOrb,
  ClickedResumeOrb,
  ClickedKillOrb,
  CancelledKillOrb,
  ConfirmedKillOrb,
  UpdatedSelectedOrb,
  FailedOrbAction,
  ClickedTranscriptDisclosure,
])

const OrbWorkspaceMessage = S.Union([
  LoadedOrbDirectory,
  FailedLoadOrbDirectory,
  SelectedOrbFile,
  LoadedOrbFile,
  FailedLoadOrbFile,
  LoadedOrbChanges,
  FailedLoadOrbChanges,
  ChangedDraft,
  GotTranscriptScrollerMessage,
  ChangedDraftMode,
  SubmittedDraft,
  AcceptedTurn,
  FailedStartTurn,
  TypingPresenceReady,
  ClickedInterrupt,
  InterruptedTurn,
  FailedInterruptTurn,
  ReceivedThreadEvent,
  ReceivedPresence,
  ThreadSubscriptionFailed,
  ClickedTogglePierreDiff,
  RenderedPierreDiff,
  FailedRenderPierreDiff,
  RenderedPierreTree,
  FailedRenderPierreTree,
  TerminalStatusChanged,
  TerminalFailed,
  RequestedTerminalReconnect,
])

const ProjectMessage = S.Union([
  ClickedThreads,
  ClickedProjects,
  LoadedProjects,
  FailedLoadProjects,
  ClickedProject,
  LoadedProject,
  FailedLoadProject,
  ChangedNewProjectField,
  ChangedNewProjectEnvKey,
  ChangedNewProjectEnvValue,
  SubmittedNewProject,
  ChangedProjectField,
  ChangedProjectEnvValue,
  RemovedProjectEnv,
  SubmittedProjectSettings,
  SavedProject,
  FailedSaveProject,
  ChangedProjectSecretField,
  SubmittedProjectSecret,
  ClickedDeleteProjectSecret,
  CancelledDeleteProjectSecret,
  ConfirmedDeleteProjectSecret,
  GotDeleteSecretDialogMessage,
])

export const AppMessage = S.Union([BackendMessage, OrbControlMessage, OrbWorkspaceMessage, ProjectMessage]).pipe(
  S.toTaggedUnion("_tag"),
)
export type AppMessage = typeof AppMessage.Type

type PierreTreeMessage =
  | typeof RenderedPierreTree.Type
  | typeof SelectedOrbFile.Type
  | typeof FailedRenderPierreTree.Type

type OrbTerminalMessage = typeof TerminalStatusChanged.Type | typeof TerminalFailed.Type

export type AppCommand = Command.Command<AppMessage>

export const MountPierreDiff = Mount.define(
  "MountPierreDiff",
  { payload_id: S.String, file_diff: PierreDiff.FileDiffMetadata, theme_type: S.Literals(["light", "dark"]) },
  RenderedPierreDiff,
  FailedRenderPierreDiff,
)(
  ({ payload_id, file_diff, theme_type }) =>
    (element) =>
      Effect.gen(function* () {
        if (!(element instanceof HTMLElement)) {
          return FailedRenderPierreDiff({ payload_id, message: "diff mount target unavailable" })
        }
        const decoded = asFileDiffMetadata(file_diff)
        if (decoded === undefined) {
          return FailedRenderPierreDiff({ payload_id, message: "diff unavailable" })
        }
        const mounted = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              let renderError: string | undefined
              const handle = mountPierreDiff({
                container: element,
                file_diff: decoded,
                theme_type,
                onRenderError: (message) => {
                  renderError = message
                },
              })
              return { handle, renderError }
            },
            catch: (cause: unknown) => cause,
          }),
          ({ handle }) => Effect.sync(() => handle.destroy()),
        )
        return mounted.renderError === undefined
          ? RenderedPierreDiff({ payload_id })
          : FailedRenderPierreDiff({ payload_id, message: mounted.renderError })
      }).pipe(
        Effect.catch((cause: unknown) =>
          Effect.succeed(
            FailedRenderPierreDiff({ payload_id, message: cause instanceof Error ? cause.message : String(cause) }),
          ),
        ),
      ),
)

export const MountPierreTree = Mount.defineStream(
  "MountPierreTree",
  {
    mount_key: S.String,
    paths: S.Array(S.String),
    selected_path: S.optional(S.String),
    git_status: S.Array(PierreTreeGitStatusEntry),
  },
  RenderedPierreTree,
  SelectedOrbFile,
  FailedRenderPierreTree,
)(
  ({ mount_key, paths, selected_path, git_status }) =>
    (element) =>
      Stream.callback<PierreTreeMessage>((queue) =>
        Effect.gen(function* () {
          if (!(element instanceof HTMLElement)) {
            Queue.offerUnsafe(queue, FailedRenderPierreTree({ message: "tree mount target unavailable" }))
            return yield* Effect.never
          }
          yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const handle = yield* Effect.try({
                try: () =>
                  mountPierreTree({
                    container: element,
                    paths,
                    git_status,
                    ...(selected_path === undefined ? {} : { selected_path }),
                    onSelectedPath: (path) => Queue.offerUnsafe(queue, SelectedOrbFile({ path })),
                  }),
                catch: (cause: unknown) => cause,
              })
              yield* pierreTreeRegistry.register(mount_key, handle)
              return handle
            }),
            (handle) =>
              Effect.gen(function* () {
                yield* pierreTreeRegistry.unregister(mount_key, handle)
                yield* Effect.sync(() => handle.destroy())
              }),
          )
          Queue.offerUnsafe(
            queue,
            selected_path === undefined ? RenderedPierreTree({}) : RenderedPierreTree({ selected_path }),
          )
          return yield* Effect.never
        }).pipe(
          Effect.catch((cause: unknown) =>
            Effect.gen(function* () {
              Queue.offerUnsafe(
                queue,
                FailedRenderPierreTree({ message: cause instanceof Error ? cause.message : String(cause) }),
              )
              return yield* Effect.never
            }),
          ),
        ),
      ),
)

export const MountOrbTerminal = Mount.defineStream(
  "MountOrbTerminal",
  { thread_id: Ids.ThreadId },
  TerminalStatusChanged,
  TerminalFailed,
)(
  ({ thread_id }) =>
    (element) =>
      Stream.callback<OrbTerminalMessage>((queue) =>
        Effect.gen(function* () {
          if (!(element instanceof HTMLElement)) {
            Queue.offerUnsafe(queue, TerminalFailed({ message: "terminal mount target unavailable" }))
            return yield* Effect.never
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const handle = mountOrbTerminal(
                {
                  container: element,
                  thread_id,
                  onStatus: (status) => Queue.offerUnsafe(queue, TerminalStatusChanged({ status })),
                  onError: (message) => Queue.offerUnsafe(queue, TerminalFailed({ message })),
                },
                undefined,
                orbTerminalRegistry,
              )
              void handle.activate()
              return handle
            }),
            (handle) => Effect.sync(() => handle.destroy()),
          )
          return yield* Effect.never
        }).pipe(
          Effect.catch((cause: unknown) =>
            Effect.gen(function* () {
              Queue.offerUnsafe(
                queue,
                TerminalFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
              )
              return yield* Effect.never
            }),
          ),
        ),
      ),
)

export const LoadBackendHealth = Command.define(
  "LoadBackendHealth",
  { api_base_url: S.String },
  LoadedBackendHealth,
  FailedBackendHealth,
)(({ api_base_url }) =>
  sdk(api_base_url)
    .backendHealth()
    .pipe(
      Effect.map((health) => LoadedBackendHealth({ health })),
      Effect.catch((error) => Effect.succeed(FailedBackendHealth({ message: error.message }))),
    ),
)

export const LoadThreads = Command.define(
  "LoadThreads",
  { api_base_url: S.String },
  LoadedThreads,
  FailedLoadThreads,
)(({ api_base_url }) =>
  sdk(api_base_url)
    .listThreads({ include_archived: false })
    .pipe(
      Effect.map((threads) => LoadedThreads({ threads })),
      Effect.catch((error) => Effect.succeed(FailedLoadThreads({ message: error.message }))),
    ),
)

export const SearchThreads = Command.define(
  "SearchThreads",
  { api_base_url: S.String, query: S.String, window: ThreadSearchWindow, now: Common.TimestampMillis },
  LoadedThreads,
  FailedLoadThreads,
)(({ api_base_url, query, window, now }) =>
  sdk(api_base_url)
    .searchThreads(searchThreadsRequest(query, window, now))
    .pipe(
      Effect.map((results) => LoadedThreads({ threads: results.map((result) => result.summary) })),
      Effect.catch((error) => Effect.succeed(FailedLoadThreads({ message: error.message }))),
    ),
)

export const LoadProjects = Command.define(
  "LoadProjects",
  { api_base_url: S.String },
  LoadedProjects,
  FailedLoadProjects,
)(({ api_base_url }) =>
  sdk(api_base_url)
    .listProjects()
    .pipe(
      Effect.map((projects) => LoadedProjects({ projects })),
      Effect.catch((error) => Effect.succeed(FailedLoadProjects({ message: error.message }))),
    ),
)

export const LoadProject = Command.define(
  "LoadProject",
  { api_base_url: S.String, project_id: Ids.ProjectId },
  LoadedProject,
  FailedLoadProject,
)(({ api_base_url, project_id }) =>
  sdk(api_base_url)
    .getProject(project_id)
    .pipe(
      Effect.map((project) => LoadedProject({ project })),
      Effect.catch((error) => Effect.succeed(FailedLoadProject({ message: error.message }))),
    ),
)

export const CreateProjectSettings = Command.define(
  "CreateProjectSettings",
  {
    api_base_url: S.String,
    name: S.String,
    repo_origin: S.String,
    default_branch: S.String,
    template_id: S.NullOr(S.String),
    env: S.Record(S.String, S.String),
  },
  SavedProject,
  FailedSaveProject,
)(({ api_base_url, name, repo_origin, default_branch, template_id, env }) =>
  sdk(api_base_url)
    .createProject({ name, repo_origin, default_branch, template_id, env })
    .pipe(
      Effect.map((project) => SavedProject({ project })),
      Effect.catch((error) => Effect.succeed(FailedSaveProject({ message: error.message }))),
    ),
)

export const UpdateProjectSettings = Command.define(
  "UpdateProjectSettings",
  {
    api_base_url: S.String,
    project_id: Ids.ProjectId,
    name: S.String,
    repo_origin: S.String,
    default_branch: S.String,
    template_id: S.NullOr(S.String),
    env: S.Record(S.String, S.String),
  },
  SavedProject,
  FailedSaveProject,
)(({ api_base_url, project_id, name, repo_origin, default_branch, template_id, env }) =>
  sdk(api_base_url)
    .updateProject(project_id, { name, repo_origin, default_branch, template_id, env })
    .pipe(
      Effect.map((project) => SavedProject({ project })),
      Effect.catch((error) => Effect.succeed(FailedSaveProject({ message: error.message }))),
    ),
)

export const SetProjectSecret = Command.define(
  "SetProjectSecret",
  { api_base_url: S.String, project_id: Ids.ProjectId, name: S.String, value: S.String },
  SavedProject,
  FailedSaveProject,
)(({ api_base_url, project_id, name, value }) =>
  sdk(api_base_url)
    .setProjectSecret(project_id, name, { value })
    .pipe(
      Effect.map((project) => SavedProject({ project })),
      Effect.catch((error) => Effect.succeed(FailedSaveProject({ message: error.message }))),
    ),
)

export const DeleteProjectSecret = Command.define(
  "DeleteProjectSecret",
  { api_base_url: S.String, project_id: Ids.ProjectId, name: S.String },
  SavedProject,
  FailedSaveProject,
)(({ api_base_url, project_id, name }) =>
  sdk(api_base_url)
    .deleteProjectSecret(project_id, name)
    .pipe(
      Effect.map((project) => SavedProject({ project })),
      Effect.catch((error) => Effect.succeed(FailedSaveProject({ message: error.message }))),
    ),
)

export const CreateThread = Command.define(
  "CreateThread",
  { api_base_url: S.String, request_token: S.Int },
  CreatedThread,
  FailedCreateThread,
)(({ api_base_url, request_token }) =>
  sdk(api_base_url)
    .createThread()
    .pipe(
      Effect.map((summary) => CreatedThread({ summary, request_token })),
      Effect.catch((error) => Effect.succeed(FailedCreateThread({ message: error.message, request_token }))),
    ),
)

export const OpenThread = Command.define(
  "OpenThread",
  { api_base_url: S.String, thread_id: Ids.ThreadId, request_token: S.Int },
  OpenedThread,
  FailedOpenThread,
)(({ api_base_url, thread_id, request_token }) =>
  sdk(api_base_url)
    .openThread(thread_id)
    .pipe(
      Effect.map((record) => OpenedThread({ record, request_token })),
      Effect.catch((error) => Effect.succeed(FailedOpenThread({ message: error.message, request_token }))),
    ),
)

export const LoadSelectedOrb = Command.define(
  "LoadSelectedOrb",
  { api_base_url: S.String, thread_id: Ids.ThreadId },
  LoadedSelectedOrb,
  FailedLoadSelectedOrb,
)(({ api_base_url, thread_id }) =>
  sdk(api_base_url)
    .getOrbByThread(thread_id)
    .pipe(
      Effect.map((orb) => LoadedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedLoadSelectedOrb({ message: error.message }))),
    ),
)

export const LoadOrbDirectory = Command.define(
  "LoadOrbDirectory",
  { api_base_url: S.String, thread_id: Ids.ThreadId, path: S.String },
  LoadedOrbDirectory,
  FailedLoadOrbDirectory,
)(({ api_base_url, thread_id, path }) =>
  orbSdk(api_base_url, thread_id)
    .orbFiles(path)
    .pipe(
      Effect.map((response) => LoadedOrbDirectory({ response })),
      Effect.catch((error) => Effect.succeed(FailedLoadOrbDirectory({ path, message: error.message }))),
    ),
)

export const LoadOrbFile = Command.define(
  "LoadOrbFile",
  { api_base_url: S.String, thread_id: Ids.ThreadId, path: S.String },
  LoadedOrbFile,
  FailedLoadOrbFile,
)(({ api_base_url, thread_id, path }) =>
  orbSdk(api_base_url, thread_id)
    .orbFile(path)
    .pipe(
      Effect.map((response) => LoadedOrbFile({ response })),
      Effect.catch((error) => Effect.succeed(FailedLoadOrbFile({ path, message: error.message }))),
    ),
)

export const LoadOrbChanges = Command.define(
  "LoadOrbChanges",
  { api_base_url: S.String, thread_id: Ids.ThreadId },
  LoadedOrbChanges,
  FailedLoadOrbChanges,
)(({ api_base_url, thread_id }) =>
  orbSdk(api_base_url, thread_id)
    .orbChanges()
    .pipe(
      Effect.map((response) => LoadedOrbChanges({ response })),
      Effect.catch((error) => Effect.succeed(FailedLoadOrbChanges({ message: error.message }))),
    ),
)

export const PauseSelectedOrb = Command.define(
  "PauseSelectedOrb",
  { api_base_url: S.String, orb_id: Ids.OrbId },
  UpdatedSelectedOrb,
  FailedOrbAction,
)(({ api_base_url, orb_id }) =>
  sdk(api_base_url)
    .pauseOrb(orb_id)
    .pipe(
      Effect.map((orb) => UpdatedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedOrbAction({ message: error.message }))),
    ),
)

export const ResumeSelectedOrb = Command.define(
  "ResumeSelectedOrb",
  { api_base_url: S.String, orb_id: Ids.OrbId },
  UpdatedSelectedOrb,
  FailedOrbAction,
)(({ api_base_url, orb_id }) =>
  sdk(api_base_url)
    .resumeOrb(orb_id)
    .pipe(
      Effect.map((orb) => UpdatedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedOrbAction({ message: error.message }))),
    ),
)

export const KillSelectedOrb = Command.define(
  "KillSelectedOrb",
  { api_base_url: S.String, orb_id: Ids.OrbId },
  UpdatedSelectedOrb,
  FailedOrbAction,
)(({ api_base_url, orb_id }) =>
  sdk(api_base_url)
    .killOrb(orb_id)
    .pipe(
      Effect.map((orb) => UpdatedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedOrbAction({ message: error.message }))),
    ),
)

export const StartTurn = Command.define(
  "StartTurn",
  {
    api_base_url: S.String,
    thread_id: Ids.ThreadId,
    user_id: S.optional(Ids.UserId),
    content: S.String,
    mode: S.optional(Remote.AgentMode),
    request_token: S.Int,
  },
  AcceptedTurn,
  FailedStartTurn,
)(({ api_base_url, thread_id, user_id, content, mode, request_token }) =>
  sdk(api_base_url, user_id)
    .startTurn({
      thread_id,
      ...(user_id === undefined ? {} : { user_id }),
      content,
      ...(mode === undefined ? {} : { mode }),
    })
    .pipe(
      Effect.map((response) => AcceptedTurn({ response, request_token })),
      Effect.catch((error) =>
        Effect.succeed(
          FailedStartTurn({
            thread_id,
            message: error.message,
            request_token,
            status: error.status,
            active_user_id: error.active_user_id,
          }),
        ),
      ),
    ),
)

export const SetThreadPresence = Command.define(
  "SetThreadPresence",
  {
    api_base_url: S.String,
    thread_id: Ids.ThreadId,
    user_id: Ids.UserId,
    state: Remote.PresenceState,
  },
  TypingPresenceReady,
)(({ api_base_url, thread_id, user_id, state }) =>
  sdk(api_base_url, user_id)
    .setThreadPresence({ thread_id, user_id, state })
    .pipe(
      Effect.andThen(state === "typing" ? Effect.sleep("4 seconds") : Effect.void),
      Effect.as(TypingPresenceReady()),
      Effect.catch(() => Effect.succeed(TypingPresenceReady())),
    ),
)

export const InterruptTurn = Command.define(
  "InterruptTurn",
  { api_base_url: S.String, thread_id: Ids.ThreadId, turn_id: Ids.TurnId },
  InterruptedTurn,
  FailedInterruptTurn,
)(({ api_base_url, thread_id, turn_id }) =>
  sdk(api_base_url)
    .interruptTurn({ thread_id, turn_id })
    .pipe(
      Effect.map((event) => InterruptedTurn({ event })),
      Effect.catch((error) => Effect.succeed(FailedInterruptTurn({ message: error.message }))),
    ),
)

export const ReconnectOrbTerminal = Command.define(
  "ReconnectOrbTerminal",
  { thread_id: Ids.ThreadId },
  TerminalStatusChanged,
  TerminalFailed,
)(({ thread_id }) =>
  reconnectOrbTerminal(thread_id).pipe(
    Effect.map((reconnected) =>
      reconnected
        ? TerminalStatusChanged({ status: "connecting" })
        : TerminalFailed({ message: "terminal is not mounted" }),
    ),
  ),
)

export const UpdatePierreTree = Command.define(
  "UpdatePierreTree",
  {
    mount_key: S.String,
    paths: S.Array(S.String),
    selected_path: S.optional(S.String),
    git_status: S.Array(PierreTreeGitStatusEntry),
  },
  RenderedPierreTree,
  FailedRenderPierreTree,
)(({ mount_key, paths, selected_path, git_status }) =>
  updatePierreTree(mount_key, {
    paths,
    git_status,
    ...(selected_path === undefined ? {} : { selected_path }),
  }).pipe(
    Effect.map(() => (selected_path === undefined ? RenderedPierreTree({}) : RenderedPierreTree({ selected_path }))),
    Effect.catch((cause: unknown) =>
      Effect.succeed(FailedRenderPierreTree({ message: cause instanceof Error ? cause.message : String(cause) })),
    ),
  ),
)

export const initialModel = (config: RuntimeConfig): Model => ({
  api_base_url: config.api_base_url,
  ...(config.user_id === undefined ? {} : { user_id: config.user_id }),
  active_view: "threads",
  connection: "idle",
  threads: [],
  thread_search_query: "",
  thread_search_window: "all",
  projects: [],
  project_form: emptyProjectForm(),
  new_project_form: emptyNewProjectForm(),
  project_secret_name: "",
  project_secret_value: "",
  pending_secret_delete_name: undefined,
  events: [],
  last_sequence: 0,
  subscription_after_sequence: 0,
  subscription_retry: 0,
  draft: "",
  pending_turn: false,
  queued_messages: [],
  pending_start_turns: [],
  creating_thread: false,
  thread_request_token: 0,
  active_thread_request_token: undefined,
  turn_request_token: 0,
  active_turn_request_token: undefined,
  presence: [],
  typing_presence_cooling: false,
  expanded_diff_ids: [],
  collapsed_transcript_row_ids: [],
  delete_secret_dialog: AlertDialog.init({ id: "delete-secret-dialog" }),
  ...initialOrbWorkspace(),
  ...(config.thread_id === undefined ? {} : { selected_thread_id: config.thread_id }),
})

export const init = (config: RuntimeConfig): readonly [Model, ReadonlyArray<AppCommand>] => {
  const base = initialModel(config)
  const openRequestToken = config.thread_id === undefined ? undefined : base.thread_request_token + 1
  const model =
    openRequestToken === undefined
      ? base
      : {
          ...base,
          thread_request_token: openRequestToken,
          active_thread_request_token: openRequestToken,
        }
  const openCommands =
    config.thread_id === undefined || openRequestToken === undefined
      ? []
      : [
          OpenThread({
            api_base_url: config.api_base_url,
            thread_id: config.thread_id,
            request_token: openRequestToken,
          }),
        ]
  return [
    { ...model, connection: "loading" },
    [
      LoadBackendHealth({ api_base_url: config.api_base_url }),
      LoadThreads({ api_base_url: config.api_base_url }),
      ...openCommands,
    ],
  ]
}

export const update = (model: Model, message: AppMessage): readonly [Model, ReadonlyArray<AppCommand>] => {
  switch (message._tag) {
    case "LoadedBackendHealth":
      return [{ ...model, backend: message.health }, []]
    case "FailedBackendHealth":
      return [{ ...model, connection: "failed", notice: message.message }, []]
    case "LoadedThreads": {
      const threads = newestFirst(message.threads)
      const next = { ...model, threads }
      if (
        model.selected_thread_id !== undefined ||
        model.creating_thread ||
        model.active_thread_request_token !== undefined ||
        threads[0] === undefined
      ) {
        return [next, []]
      }
      return openThreadModel(next, threads[0].thread_id)
    }
    case "FailedLoadThreads":
      return [{ ...model, connection: "failed", notice: message.message }, []]
    case "ChangedThreadSearchQuery": {
      const next = { ...model, thread_search_query: message.value, active_view: "threads" as const, notice: undefined }
      return [next, [searchThreadsCommand(next, message.now)]]
    }
    case "ChangedThreadSearchWindow": {
      const next = {
        ...model,
        thread_search_window: threadSearchWindowFromValue(message.value),
        active_view: "threads" as const,
        notice: undefined,
      }
      return [next, [searchThreadsCommand(next, message.now)]]
    }
    case "ClickedThread":
      return openThreadModel(model, message.thread_id)
    case "ClickedNewThread": {
      const requestToken = model.thread_request_token + 1
      return [
        {
          ...model,
          thread_request_token: requestToken,
          active_thread_request_token: requestToken,
          selected_thread_id: undefined,
          subscribed_thread_id: undefined,
          selected_orb: undefined,
          ...initialOrbWorkspace(),
          confirm_kill_orb_id: undefined,
          expanded_diff_ids: [],
          collapsed_transcript_row_ids: [],
          pending_interrupt_turn_id: undefined,
          pending_turn: false,
          pending_submit: undefined,
          pending_submit_mode: undefined,
          active_turn_request_token: undefined,
          events: [],
          last_sequence: 0,
          subscription_after_sequence: 0,
          subscription_retry: 0,
          presence: [],
          typing_presence_cooling: false,
          creating_thread: true,
          connection: "loading",
          notice: undefined,
        },
        [CreateThread({ api_base_url: model.api_base_url, request_token: requestToken })],
      ]
    }
    case "CreatedThread":
      return createdThreadModel(model, message.summary, message.request_token)
    case "FailedCreateThread":
      return failedCreateThreadModel(model, message)
    case "OpenedThread":
      return openedThreadModel(model, message.record, message.request_token)
    case "FailedOpenThread":
      return failedOpenThreadModel(model, message)
    case "LoadedSelectedOrb":
      return selectedOrbLoadedModel(model, message.orb)
    case "FailedLoadSelectedOrb":
      return [{ ...model, notice: message.message }, []]
    case "GotOrbTabsMessage":
      return orbTabsModel(model, message.message)
    case "GotKillOrbDialogMessage":
      return killOrbDialogModel(model, message.message)
    case "ClickedPauseOrb":
      return selectedOrbActionModel(model, "pause")
    case "ClickedResumeOrb":
      return selectedOrbActionModel(model, "resume")
    case "ClickedKillOrb":
      return clickedKillOrbModel(model)
    case "CancelledKillOrb":
      return cancelKillOrbModel(model)
    case "ConfirmedKillOrb":
      return confirmedKillOrbModel(model)
    case "UpdatedSelectedOrb":
      return selectedOrbLoadedModel(model, message.orb)
    case "FailedOrbAction":
      return [{ ...model, confirm_kill_orb_id: undefined, notice: message.message }, []]
    case "ClickedTranscriptDisclosure":
      return [
        { ...model, collapsed_transcript_row_ids: toggleString(model.collapsed_transcript_row_ids, message.row_id) },
        [],
      ]
    case "LoadedOrbDirectory":
      return loadedOrbDirectoryModel(model, message.response)
    case "FailedLoadOrbDirectory":
      return failedLoadOrbDirectoryModel(model, message.path, message.message)
    case "SelectedOrbFile":
      return selectedOrbFileModel(model, message.path)
    case "LoadedOrbFile":
      return loadedOrbFileModel(model, message.response)
    case "FailedLoadOrbFile":
      return failedLoadOrbFileModel(model, message.path, message.message)
    case "LoadedOrbChanges":
      return loadedOrbChangesModel(model, message.response)
    case "FailedLoadOrbChanges":
      return [{ ...model, orb_changes: { state: "failed", message: message.message }, notice: message.message }, []]
    case "GotTranscriptScrollerMessage":
      return transcriptScrollerModel(model, message.message)
    case "ChangedDraft":
      return changedDraftModel(model, message.value)
    case "ChangedDraftMode":
      return [{ ...model, draft_mode: agentModeFromValue(message.value) }, []]
    case "SubmittedDraft":
      return submittedDraftModel(model)
    case "AcceptedTurn":
      return acceptedTurnModel(model, message)
    case "FailedStartTurn":
      return failedStartTurnModel(model, message)
    case "TypingPresenceReady":
      return [{ ...model, typing_presence_cooling: false }, []]
    case "ClickedInterrupt":
      return interruptTurnModel(model)
    case "InterruptedTurn":
      return [{ ...model, pending_interrupt_turn_id: undefined }, []]
    case "FailedInterruptTurn":
      return [{ ...model, pending_interrupt_turn_id: undefined, notice: message.message }, []]
    case "ReceivedThreadEvent":
      return receivedEventModel(model, message.event)
    case "ReceivedPresence":
      return receivedPresenceModel(model, message.presence)
    case "ThreadSubscriptionFailed":
      return [
        {
          ...model,
          connection: "failed",
          subscription_after_sequence: model.last_sequence,
          subscription_retry: model.subscription_retry + 1,
          notice: message.message,
        },
        [],
      ]
    case "ClickedTogglePierreDiff":
      return [{ ...model, expanded_diff_ids: toggleString(model.expanded_diff_ids, message.payload_id) }, []]
    case "RenderedPierreDiff":
      return [model, []]
    case "FailedRenderPierreDiff":
      return [{ ...model, notice: `${message.payload_id}: ${message.message}` }, []]
    case "RenderedPierreTree":
      return [model, []]
    case "FailedRenderPierreTree":
      return [{ ...model, notice: message.message }, []]
    case "TerminalStatusChanged":
      return [
        {
          ...model,
          orb_terminal_status: message.status,
          orb_terminal_error: message.status === "failed" ? model.orb_terminal_error : undefined,
        },
        [],
      ]
    case "TerminalFailed":
      return [
        { ...model, orb_terminal_status: "failed", orb_terminal_error: message.message, notice: message.message },
        [],
      ]
    case "RequestedTerminalReconnect":
      return model.selected_thread_id === undefined
        ? [model, []]
        : [
            { ...model, orb_terminal_status: "connecting", orb_terminal_error: undefined },
            [ReconnectOrbTerminal({ thread_id: model.selected_thread_id })],
          ]
    case "ClickedThreads":
      return [{ ...model, active_view: "threads", notice: undefined }, []]
    case "ClickedProjects":
      return [
        { ...model, active_view: "projects", notice: undefined },
        model.projects.length === 0 ? [LoadProjects({ api_base_url: model.api_base_url })] : [],
      ]
    case "LoadedProjects":
      return [{ ...model, projects: message.projects, notice: undefined }, []]
    case "FailedLoadProjects":
      return [{ ...model, notice: message.message }, []]
    case "ClickedProject":
      return clickedProjectModel(model, message.project_id)
    case "LoadedProject":
      return loadedProjectModel(model, message.project)
    case "FailedLoadProject":
      return [{ ...model, notice: message.message }, []]
    case "ChangedNewProjectField":
      return [
        {
          ...model,
          new_project_form: { ...model.new_project_form, [message.field]: message.value },
        },
        [],
      ]
    case "ChangedNewProjectEnvKey":
      return [{ ...model, new_project_form: { ...model.new_project_form, env_key: message.value } }, []]
    case "ChangedNewProjectEnvValue":
      return [{ ...model, new_project_form: { ...model.new_project_form, env_value: message.value } }, []]
    case "SubmittedNewProject":
      return submittedNewProjectModel(model)
    case "ChangedProjectField":
      return [{ ...model, project_form: { ...model.project_form, [message.field]: message.value } }, []]
    case "ChangedProjectEnvValue":
      return [
        {
          ...model,
          project_form: { ...model.project_form, env: { ...model.project_form.env, [message.key]: message.value } },
        },
        [],
      ]
    case "RemovedProjectEnv":
      return [
        { ...model, project_form: { ...model.project_form, env: withoutKey(model.project_form.env, message.key) } },
        [],
      ]
    case "SubmittedProjectSettings":
      return submittedProjectSettingsModel(model)
    case "SavedProject":
      return savedProjectModel(model, message.project)
    case "FailedSaveProject":
      return [{ ...model, notice: message.message }, []]
    case "ChangedProjectSecretField":
      return [
        message.field === "name"
          ? { ...model, project_secret_name: message.value }
          : { ...model, project_secret_value: message.value },
        [],
      ]
    case "SubmittedProjectSecret":
      return submittedProjectSecretModel(model)
    case "ClickedDeleteProjectSecret":
      return clickedDeleteSecretModel(model, message.name)
    case "CancelledDeleteProjectSecret":
      return cancelDeleteSecretModel(model)
    case "ConfirmedDeleteProjectSecret": {
      const name = model.pending_secret_delete_name
      if (model.selected_project_id === undefined || name === undefined) return [model, []]
      const [delete_secret_dialog, dialogCommands] = AlertDialog.close(model.delete_secret_dialog)
      return [
        { ...model, pending_secret_delete_name: undefined, notice: undefined, delete_secret_dialog },
        [
          DeleteProjectSecret({
            api_base_url: model.api_base_url,
            project_id: model.selected_project_id,
            name,
          }),
          ...Command.mapMessages(dialogCommands, (childMessage) =>
            GotDeleteSecretDialogMessage({ message: childMessage }),
          ),
        ],
      ]
    }
    case "GotDeleteSecretDialogMessage":
      return deleteSecretDialogModel(model, message.message)
  }
  return [model, []]
}

const threadSubscriptionRetrySchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.modifyDelay((_error, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(5)))),
)

export const subscriptions = Subscription.make<Model, AppMessage>()((entry) => ({
  threadEvents: entry(
    {
      api_base_url: S.String,
      thread_id: S.optional(Ids.ThreadId),
      user_id: S.optional(Ids.UserId),
      after_sequence: S.Int,
      retry: S.Int,
    },
    {
      modelToDependencies: (model) => ({
        api_base_url: model.api_base_url,
        ...(model.subscribed_thread_id === undefined ? {} : { thread_id: model.subscribed_thread_id }),
        ...(model.user_id === undefined ? {} : { user_id: model.user_id }),
        after_sequence: model.subscription_after_sequence,
        retry: model.subscription_retry,
      }),
      dependenciesToStream: ({ api_base_url, thread_id, user_id, after_sequence }) =>
        thread_id === undefined
          ? Stream.empty
          : Stream.unwrap(
              Effect.gen(function* () {
                const presence = yield* Queue.unbounded<AppMessage>()
                return sdk(api_base_url, user_id)
                  .subscribeThreadEvents({
                    thread_id,
                    after_sequence,
                    ...(user_id === undefined ? {} : { user_id }),
                    onPresence: (snapshot) => Queue.offerUnsafe(presence, ReceivedPresence({ presence: snapshot })),
                  })
                  .pipe(
                    Stream.retry(threadSubscriptionRetrySchedule),
                    Stream.map((event) => ReceivedThreadEvent({ event })),
                    Stream.catch((error) => Stream.make(ThreadSubscriptionFailed({ message: error.message }))),
                    Stream.merge(Stream.fromQueue(presence)),
                  )
              }),
            ),
    },
  ),
}))

export const foldStreamEvents = (events: ReadonlyArray<Event.Event>): ReadonlyArray<Event.Event> => {
  const output: Array<Event.Event | undefined> = []
  const openContent = new Map<string, number>()
  const openReasoning = new Map<string, number>()
  const openToolInput = new Map<string, number>()
  const seal = (turnId: string | undefined) => {
    if (turnId === undefined) {
      openContent.clear()
      openReasoning.clear()
      return
    }
    openContent.delete(turnId)
    openReasoning.delete(turnId)
  }
  for (const event of events) {
    switch (event.type) {
      case "model.stream.chunk": {
        const index = openContent.get(event.turn_id)
        const open = index === undefined ? undefined : output[index]
        if (index !== undefined && open?.type === "model.stream.chunk") {
          output[index] = { ...open, data: { ...open.data, text: `${open.data.text}${event.data.text}` } }
        } else {
          openContent.set(event.turn_id, output.length)
          output.push(event)
        }
        break
      }
      case "model.reasoning.delta": {
        const index = openReasoning.get(event.turn_id)
        const open = index === undefined ? undefined : output[index]
        if (index !== undefined && open?.type === "model.reasoning.delta") {
          output[index] = { ...open, data: { ...open.data, text: `${open.data.text}${event.data.text}` } }
        } else {
          openReasoning.set(event.turn_id, output.length)
          output.push(event)
        }
        break
      }
      case "tool.call.input.delta": {
        const index = openToolInput.get(event.data.id)
        const open = index === undefined ? undefined : output[index]
        if (index !== undefined && open?.type === "tool.call.input.delta") {
          output[index] = { ...open, data: { ...open.data, text: `${open.data.text}${event.data.text}` } }
        } else {
          openToolInput.set(event.data.id, output.length)
          output.push(event)
        }
        break
      }
      case "tool.call.input.ended": {
        seal(event.turn_id)
        const index = openToolInput.get(event.data.id)
        if (index !== undefined) {
          output[index] = undefined
          openToolInput.delete(event.data.id)
        }
        output.push(event)
        break
      }
      case "message.added": {
        const turnId = event.turn_id
        if (event.data.message.role === "assistant" && turnId !== undefined) {
          const index = openContent.get(turnId)
          if (index !== undefined) {
            output[index] = undefined
            openContent.delete(turnId)
          }
          openReasoning.delete(turnId)
        } else {
          seal(turnId)
        }
        output.push(event)
        break
      }
      case "turn.completed":
      case "turn.failed": {
        seal(event.turn_id)
        openToolInput.clear()
        output.push(event)
        break
      }
      case "tool.call.input.started":
      case "tool.call.requested":
      case "tool.call.completed":
      case "skill.loaded":
      case "subagent.completed":
      case "turn.started": {
        seal(event.turn_id)
        output.push(event)
        break
      }
      default:
        output.push(event)
    }
  }
  return output.filter((event) => event !== undefined)
}

export const eventRows = (
  events: ReadonlyArray<Event.Event>,
  expandedDiffIds: ReadonlySet<string> = new Set(),
  userId?: Ids.UserId,
  collapsedTranscriptRowIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<TranscriptRow> =>
  foldStreamEvents(events).flatMap((event) => {
    switch (event.type) {
      case "message.added": {
        const author = messageAuthor(event.data.message, userId)
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "message",
          title: roleLabel(event.data.message.role),
          body: RikaMessage.displayText(event.data.message),
          ...(author === undefined ? {} : { author }),
        }
      }
      case "model.stream.chunk":
        return { id: event.id, sequence: event.sequence, kind: "message", title: "Rika", body: event.data.text }
      case "model.reasoning.delta":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Reasoning",
          body: event.data.text,
          is_open: !collapsedTranscriptRowIds.has(event.id),
        }
      case "tool.call.requested":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "tool",
          title: `Tool: ${event.data.call.name}`,
          body: "Running",
          is_open: !collapsedTranscriptRowIds.has(event.id),
        }
      case "tool.call.completed":
        return (
          diffRows({
            eventId: event.id,
            sequence: event.sequence,
            title: `Tool: ${event.data.result.name}`,
            fallbackKind: event.data.result.status === "success" ? "tool" : "error",
            value: event.data.result.output,
            expandedDiffIds,
            collapsedTranscriptRowIds,
          }) ?? {
            id: event.id,
            sequence: event.sequence,
            kind: event.data.result.status === "success" ? "tool" : "error",
            title: `Tool: ${event.data.result.name}`,
            body: event.data.result.status,
            is_open: !collapsedTranscriptRowIds.has(event.id),
          }
        )
      case "turn.started":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Turn started", body: event.turn_id }
      case "turn.completed":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Turn completed", body: event.turn_id }
      case "turn.failed":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "error",
          title: "Turn failed",
          body: event.data.error.message,
        }
      case "context.resolved":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Context resolved",
          body: `${event.data.entries.length} entries · ${event.data.total_chars} chars`,
        }
      case "context.compacted":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Context compacted",
          body: `${event.data.trigger} · tail starts at ${event.data.tail_start_sequence}`,
        }
      case "context.pruned":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Context pruned",
          body: `${event.data.tool_call_ids.length} tools · ${event.data.estimated_tokens_freed} tokens`,
        }
      case "skill.loaded":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Skill loaded", body: event.data.name }
      case "subagent.completed":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: `Subagent ${event.data.status}`,
          body: event.data.summary,
        }
      case "artifact.created":
        return (
          diffRows({
            eventId: event.id,
            sequence: event.sequence,
            title: `Artifact: ${event.data.artifact.title ?? event.data.artifact.kind}`,
            fallbackKind: "event",
            value: event.data.artifact.content,
            expandedDiffIds,
            collapsedTranscriptRowIds,
          }) ?? {
            id: event.id,
            sequence: event.sequence,
            kind: "event",
            title: "Artifact created",
            body: event.data.artifact.title ?? event.data.artifact.kind,
          }
        )
      case "thread.created":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Thread created",
          body: event.data.workspace_id,
        }
      case "thread.archived":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Thread archived", body: "Archived" }
      case "thread.unarchived":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Thread unarchived", body: "Unarchived" }
      case "thread.visibility.set":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Thread visibility",
          body: event.data.visibility,
        }
      case "tool.call.input.started":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "tool",
          title: `Tool input: ${event.data.name}`,
          body: "Started",
          is_open: !collapsedTranscriptRowIds.has(event.id),
        }
      case "tool.call.input.delta":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "tool",
          title: "Tool input",
          body: event.data.text,
          is_open: !collapsedTranscriptRowIds.has(event.id),
        }
      case "tool.call.input.ended":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "tool",
          title: `Tool input: ${event.data.name}`,
          body: event.data.input_text,
          is_open: !collapsedTranscriptRowIds.has(event.id),
        }
    }
    return unreachableEventRow(event)
  })

export const activeTurnId = (events: ReadonlyArray<Event.Event>): Ids.TurnId | undefined => {
  let active: Ids.TurnId | undefined
  for (const event of events) {
    if (event.type === "turn.started") active = event.turn_id
    if ((event.type === "turn.completed" || event.type === "turn.failed") && event.turn_id === active) {
      active = undefined
    }
  }
  return active
}

export const contextUsage = (model: Model): ContextUsage | undefined => {
  const latest = model.events.findLast(
    (event): event is Event.TurnCompleted =>
      event.type === "turn.completed" && event.data.usage?.input_tokens !== undefined,
  )
  const selected = model.threads.find((thread) => thread.thread_id === model.selected_thread_id)
  const tokens = latest?.data.usage?.input_tokens ?? selected?.context_tokens
  const window =
    latest?.data.model === undefined
      ? selected?.context_window
      : ModelInfo.modelInfo(latest.data.model, {}).context_window
  if (tokens === undefined || window === undefined) return undefined
  const percent = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))
  return {
    tokens,
    window,
    percent,
    tone: percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal",
  }
}

const sdk = (apiBaseUrl: string, userId?: Ids.UserId) =>
  Client.make(Client.fetchTransport({ base_url: apiBaseUrl, ...(userId === undefined ? {} : { user_id: userId }) }))

const orbSdk = (apiBaseUrl: string, threadId: Ids.ThreadId) =>
  sdk(`${apiBaseUrl.replace(/\/$/, "")}/orb/by-thread/${encodeURIComponent(threadId)}`)

const searchThreadsCommand = (model: Model, now: Common.TimestampMillis): AppCommand =>
  SearchThreads({
    api_base_url: model.api_base_url,
    query: model.thread_search_query,
    window: model.thread_search_window,
    now,
  })

const searchThreadsRequest = (
  query: string,
  window: ThreadSearchWindow,
  now: Common.TimestampMillis,
): Remote.SearchThreadsRequest => {
  const trimmed = query.trim()
  return {
    ...(trimmed.length === 0 ? {} : { query: trimmed }),
    include_archived: false,
    ...searchWindowAfter(window, now),
  }
}

const searchWindowAfter = (
  window: ThreadSearchWindow,
  now: Common.TimestampMillis,
): Pick<Remote.SearchThreadsRequest, "after"> => {
  if (window === "all") return {}
  const delta = window === "24h" ? 24 : window === "72h" ? 72 : 7 * 24
  return { after: Common.TimestampMillis.make(now - delta * 60 * 60 * 1_000) }
}

const threadSearchWindowFromValue = (value: string): ThreadSearchWindow =>
  value === "24h" || value === "72h" || value === "7d" || value === "all" ? value : "all"

const emptyProjectForm = (): ProjectForm => ({
  name: "",
  repo_origin: "",
  default_branch: "main",
  template_id: "",
  env: {},
})

const emptyNewProjectForm = (): NewProjectForm => ({
  name: "",
  repo_origin: "",
  default_branch: "main",
  template_id: "",
  env_key: "",
  env_value: "",
})

const projectFormFromDetail = (project: Remote.ProjectDetail): ProjectForm => ({
  name: project.name,
  repo_origin: project.repo_origin,
  default_branch: project.default_branch,
  template_id: project.template_id ?? "",
  env: project.env,
})

const projectSummaryFromDetail = (project: Remote.ProjectDetail): Remote.ProjectSummary => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: project.repo_origin,
  default_branch: project.default_branch,
  template_id: project.template_id,
  env_keys: Object.keys(project.env).toSorted(),
  secret_names: project.secret_names,
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const projectLoadedModel = (model: Model, project: Remote.ProjectDetail): Model => ({
  ...model,
  active_view: "projects",
  selected_project_id: project.project_id,
  selected_project: project,
  project_form: projectFormFromDetail(project),
  project_secret_name: project.secret_names[0] ?? "",
  project_secret_value: "",
  pending_secret_delete_name: undefined,
  projects: newestProjectFirst([projectSummaryFromDetail(project), ...model.projects]),
  notice: undefined,
})

const closeDeleteSecretDialog = (model: Model): readonly [AlertDialog.Model, ReadonlyArray<AppCommand>] => {
  const [delete_secret_dialog, dialogCommands] = AlertDialog.close(model.delete_secret_dialog)
  return [
    delete_secret_dialog,
    Command.mapMessages(dialogCommands, (childMessage) => GotDeleteSecretDialogMessage({ message: childMessage })),
  ]
}

const clickedProjectModel = (model: Model, projectId: Ids.ProjectId): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [delete_secret_dialog, dialogCommands] = closeDeleteSecretDialog(model)
  return [
    {
      ...model,
      active_view: "projects",
      selected_project_id: projectId,
      selected_project: undefined,
      project_form: emptyProjectForm(),
      project_secret_name: "",
      project_secret_value: "",
      pending_secret_delete_name: undefined,
      delete_secret_dialog,
      notice: undefined,
    },
    [...dialogCommands, LoadProject({ api_base_url: model.api_base_url, project_id: projectId })],
  ]
}

const loadedProjectModel = (
  model: Model,
  project: Remote.ProjectDetail,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [delete_secret_dialog, dialogCommands] = closeDeleteSecretDialog(model)
  return [{ ...projectLoadedModel(model, project), delete_secret_dialog }, dialogCommands]
}

const savedProjectModel = (
  model: Model,
  project: Remote.ProjectDetail,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [delete_secret_dialog, dialogCommands] = closeDeleteSecretDialog(model)
  return [
    {
      ...projectLoadedModel(model, project),
      projects: newestProjectFirst([projectSummaryFromDetail(project), ...model.projects]),
      new_project_form: emptyNewProjectForm(),
      project_secret_value: "",
      pending_secret_delete_name: undefined,
      delete_secret_dialog,
      notice: undefined,
    },
    dialogCommands,
  ]
}

const submittedNewProjectModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  const form = model.new_project_form
  const name = form.name.trim()
  const repoOrigin = form.repo_origin.trim()
  if (name.length === 0 || repoOrigin.length === 0) return [model, []]
  const envKey = form.env_key.trim()
  const env = envKey.length === 0 ? {} : { [envKey]: form.env_value }
  return [
    { ...model, notice: undefined },
    [
      CreateProjectSettings({
        api_base_url: model.api_base_url,
        name,
        repo_origin: repoOrigin,
        default_branch: nonEmptyOr(form.default_branch, "main"),
        template_id: nullableText(form.template_id),
        env,
      }),
    ],
  ]
}

const submittedProjectSettingsModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_project_id === undefined) return [model, []]
  const form = model.project_form
  const name = form.name.trim()
  const repoOrigin = form.repo_origin.trim()
  if (name.length === 0 || repoOrigin.length === 0) return [model, []]
  return [
    { ...model, notice: undefined },
    [
      UpdateProjectSettings({
        api_base_url: model.api_base_url,
        project_id: model.selected_project_id,
        name,
        repo_origin: repoOrigin,
        default_branch: nonEmptyOr(form.default_branch, "main"),
        template_id: nullableText(form.template_id),
        env: form.env,
      }),
    ],
  ]
}

const submittedProjectSecretModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_project_id === undefined) return [model, []]
  const name = model.project_secret_name.trim()
  const value = model.project_secret_value
  if (name.length === 0 || value.length === 0) return [model, []]
  return [
    { ...model, project_secret_value: "", notice: undefined },
    [SetProjectSecret({ api_base_url: model.api_base_url, project_id: model.selected_project_id, name, value })],
  ]
}

const clickedDeleteSecretModel = (model: Model, name: string): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [delete_secret_dialog, dialogCommands] = AlertDialog.open(model.delete_secret_dialog)
  return [
    { ...model, pending_secret_delete_name: name, delete_secret_dialog, notice: undefined },
    Command.mapMessages(dialogCommands, (childMessage) => GotDeleteSecretDialogMessage({ message: childMessage })),
  ]
}

const deleteSecretDialogModel = (
  model: Model,
  message: AlertDialog.Message,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [delete_secret_dialog, dialogCommands, maybeOutMessage] = AlertDialog.update(
    model.delete_secret_dialog,
    message,
  )
  return [
    {
      ...model,
      delete_secret_dialog,
      pending_secret_delete_name: dialogWasClosed(maybeOutMessage) ? undefined : model.pending_secret_delete_name,
    },
    Command.mapMessages(dialogCommands, (childMessage) => GotDeleteSecretDialogMessage({ message: childMessage })),
  ]
}

const cancelDeleteSecretModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [delete_secret_dialog, dialogCommands] = AlertDialog.close(model.delete_secret_dialog)
  return [
    { ...model, pending_secret_delete_name: undefined, delete_secret_dialog, notice: undefined },
    Command.mapMessages(dialogCommands, (childMessage) => GotDeleteSecretDialogMessage({ message: childMessage })),
  ]
}

const newestProjectFirst = (projects: ReadonlyArray<Remote.ProjectSummary>) => {
  const seen = new Set<Ids.ProjectId>()
  const unique = projects.filter((project) => {
    if (seen.has(project.project_id)) return false
    seen.add(project.project_id)
    return true
  })
  return unique.toSorted((left, right) => right.updated_at - left.updated_at || left.name.localeCompare(right.name))
}

const nullableText = (value: string) => {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

const nonEmptyOr = (value: string, fallback: string) => {
  const trimmed = value.trim()
  return trimmed.length === 0 ? fallback : trimmed
}

const withoutKey = (input: Record<string, string>, key: string) => {
  const next = { ...input }
  delete next[key]
  return next
}

const openThreadModel = (model: Model, threadId: Ids.ThreadId): readonly [Model, ReadonlyArray<AppCommand>] => {
  const requestToken = model.thread_request_token + 1
  return [
    {
      ...model,
      thread_request_token: requestToken,
      active_thread_request_token: requestToken,
      selected_thread_id: threadId,
      subscribed_thread_id: undefined,
      selected_orb: undefined,
      ...initialOrbWorkspace(),
      confirm_kill_orb_id: undefined,
      expanded_diff_ids: [],
      collapsed_transcript_row_ids: [],
      pending_interrupt_turn_id: undefined,
      events: [],
      last_sequence: 0,
      subscription_after_sequence: 0,
      subscription_retry: 0,
      presence: [],
      typing_presence_cooling: false,
      pending_turn: false,
      pending_submit: undefined,
      pending_submit_mode: undefined,
      active_turn_request_token: undefined,
      creating_thread: false,
      connection: "loading",
      notice: undefined,
    },
    [OpenThread({ api_base_url: model.api_base_url, thread_id: threadId, request_token: requestToken })],
  ]
}

const createdThreadModel = (
  model: Model,
  summary: Remote.ThreadSummary,
  requestToken: number,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (
    !model.creating_thread ||
    model.selected_thread_id !== undefined ||
    model.active_thread_request_token !== requestToken
  ) {
    return [model, []]
  }
  const next = {
    ...model,
    threads: newestFirst([summary, ...model.threads.filter((thread) => thread.thread_id !== summary.thread_id)]),
    active_thread_request_token: undefined,
    selected_thread_id: summary.thread_id,
    subscribed_thread_id: summary.thread_id,
    selected_orb: undefined,
    ...initialOrbWorkspace(),
    confirm_kill_orb_id: undefined,
    expanded_diff_ids: [],
    collapsed_transcript_row_ids: [],
    pending_interrupt_turn_id: undefined,
    events: [],
    last_sequence: 0,
    subscription_after_sequence: 0,
    subscription_retry: 0,
    presence: [],
    typing_presence_cooling: false,
    creating_thread: false,
    connection: "connected" as const,
    notice: undefined,
  }
  const content = model.pending_submit
  const mode = model.pending_submit_mode
  if (content === undefined || content.length === 0) {
    return [{ ...next, pending_submit: undefined, pending_submit_mode: undefined }, []]
  }
  const turnRequestToken = next.turn_request_token + 1
  return [
    trackPendingStartTurn(
      {
        ...next,
        turn_request_token: turnRequestToken,
        active_turn_request_token: turnRequestToken,
        pending_turn: true,
        pending_submit: content,
        pending_submit_mode: mode,
      },
      {
        thread_id: summary.thread_id,
        request_token: turnRequestToken,
        content,
        mode,
      },
    ),
    [
      StartTurn({
        api_base_url: model.api_base_url,
        thread_id: summary.thread_id,
        user_id: model.user_id,
        content,
        mode,
        request_token: turnRequestToken,
      }),
    ],
  ]
}

const failedCreateThreadModel = (
  model: Model,
  message: typeof FailedCreateThread.Type,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.active_thread_request_token !== message.request_token) return [model, []]
  return [
    {
      ...model,
      active_thread_request_token: undefined,
      connection: "failed",
      pending_turn: false,
      pending_submit: undefined,
      pending_submit_mode: undefined,
      active_turn_request_token: undefined,
      creating_thread: false,
      draft: model.pending_submit ?? model.draft,
      notice: message.message,
    },
    [],
  ]
}

const openedThreadModel = (
  model: Model,
  record: Remote.ThreadRecord,
  requestToken: number,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_thread_id !== record.summary.thread_id || model.active_thread_request_token !== requestToken) {
    return [model, []]
  }
  const lastSequence = lastEventSequence(record.events)
  const next = {
    ...model,
    active_thread_request_token: undefined,
    selected_thread_id: record.summary.thread_id,
    subscribed_thread_id: record.summary.thread_id,
    selected_orb: undefined,
    ...initialOrbWorkspace(),
    confirm_kill_orb_id: undefined,
    expanded_diff_ids: [],
    collapsed_transcript_row_ids: [],
    pending_interrupt_turn_id: undefined,
    threads: newestFirst([
      record.summary,
      ...model.threads.filter((thread) => thread.thread_id !== record.summary.thread_id),
    ]),
    events: record.events,
    last_sequence: lastSequence,
    subscription_after_sequence: lastSequence,
    subscription_retry: 0,
    presence: [],
    typing_presence_cooling: false,
    creating_thread: false,
    connection: "connected" as const,
    notice: undefined,
  }
  const orbCommands =
    record.summary.orb_status === undefined
      ? []
      : [LoadSelectedOrb({ api_base_url: model.api_base_url, thread_id: record.summary.thread_id })]
  const [drained, drainCommands] = drainQueuedMessagesModel(next)
  return [drained, [...orbCommands, ...drainCommands]]
}

const failedOpenThreadModel = (
  model: Model,
  message: typeof FailedOpenThread.Type,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.active_thread_request_token !== message.request_token) return [model, []]
  return [{ ...model, active_thread_request_token: undefined, connection: "failed", notice: message.message }, []]
}

const changedDraftModel = (model: Model, value: string): readonly [Model, ReadonlyArray<AppCommand>] => {
  const next = { ...model, draft: value }
  if (value.trim().length === 0) {
    const command = model.typing_presence_cooling ? presenceCommand(model, "active") : undefined
    return [{ ...next, typing_presence_cooling: false }, command === undefined ? [] : [command]]
  }
  if (model.typing_presence_cooling) return [next, []]
  const command = presenceCommand(next, "typing")
  return command === undefined ? [next, []] : [{ ...next, typing_presence_cooling: true }, [command]]
}

const submittedDraftModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  const content = model.draft.trim()
  if (content.length === 0) return [model, []]
  if (activeTurnId(model.events) !== undefined && model.selected_thread_id !== undefined) {
    return queueSubmittedMessageModel(
      model,
      { thread_id: model.selected_thread_id, content, mode: model.draft_mode },
      "Turn already active - message queued",
    )
  }
  if (model.selected_thread_id === undefined) {
    const requestToken = model.thread_request_token + 1
    return [
      {
        ...model,
        thread_request_token: requestToken,
        active_thread_request_token: requestToken,
        draft: "",
        pending_turn: true,
        pending_submit: content,
        pending_submit_mode: model.draft_mode,
        typing_presence_cooling: false,
        creating_thread: true,
        connection: "loading",
        notice: undefined,
      },
      [CreateThread({ api_base_url: model.api_base_url, request_token: requestToken })],
    ]
  }
  const turnRequestToken = model.turn_request_token + 1
  const presence = presenceCommand(model, "active")
  return [
    trackPendingStartTurn(
      {
        ...model,
        turn_request_token: turnRequestToken,
        active_turn_request_token: turnRequestToken,
        draft: "",
        pending_turn: true,
        pending_submit: content,
        pending_submit_mode: model.draft_mode,
        notice: undefined,
        typing_presence_cooling: false,
      },
      {
        thread_id: model.selected_thread_id,
        request_token: turnRequestToken,
        content,
        mode: model.draft_mode,
      },
    ),
    [
      ...(presence === undefined ? [] : [presence]),
      StartTurn({
        api_base_url: model.api_base_url,
        thread_id: model.selected_thread_id,
        user_id: model.user_id,
        content,
        mode: model.draft_mode,
        request_token: turnRequestToken,
      }),
    ],
  ]
}

const acceptedTurnModel = (
  model: Model,
  message: typeof AcceptedTurn.Type,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const next = removePendingStartTurn(model, message.response.thread_id, message.request_token)
  if (model.active_turn_request_token !== message.request_token) return [next, []]
  if (model.selected_thread_id !== message.response.thread_id) return [next, []]
  return [
    {
      ...next,
      active_turn_request_token: undefined,
      pending_submit: undefined,
      pending_submit_mode: undefined,
      notice: undefined,
    },
    [],
  ]
}

const failedStartTurnModel = (
  model: Model,
  message: typeof FailedStartTurn.Type,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const pending = pendingStartTurn(model, message.thread_id, message.request_token)
  if (model.active_turn_request_token !== message.request_token && pending === undefined) return [model, []]
  const withoutPending = removePendingStartTurn(model, message.thread_id, message.request_token)
  const isActiveFailure = model.active_turn_request_token === message.request_token
  const cleared = isActiveFailure
    ? {
        ...withoutPending,
        active_turn_request_token: undefined,
        pending_turn: false,
        pending_submit: undefined,
        pending_submit_mode: undefined,
      }
    : withoutPending
  if (message.status === 409 && pending !== undefined) {
    return queueSubmittedMessageModel(
      cleared,
      queuedFromPendingStartTurn(pending),
      conflictNotice(message.active_user_id),
    )
  }
  if (!isActiveFailure) {
    return [{ ...cleared, notice: message.message }, []]
  }
  return [
    {
      ...cleared,
      draft: pending?.content ?? model.pending_submit ?? model.draft,
      notice: message.message,
    },
    [],
  ]
}

const trackPendingStartTurn = (model: Model, pending: PendingStartTurn): Model => ({
  ...model,
  pending_start_turns: [...model.pending_start_turns.filter((entry) => entry.thread_id !== pending.thread_id), pending],
})

const pendingStartTurn = (model: Model, threadId: Ids.ThreadId, requestToken: number): PendingStartTurn | undefined =>
  model.pending_start_turns.find((entry) => entry.thread_id === threadId && entry.request_token === requestToken)

const removePendingStartTurn = (model: Model, threadId: Ids.ThreadId, requestToken: number): Model => {
  const pending_start_turns = model.pending_start_turns.filter(
    (entry) => entry.thread_id !== threadId || entry.request_token !== requestToken,
  )
  return pending_start_turns.length === model.pending_start_turns.length ? model : { ...model, pending_start_turns }
}

const queuedFromPendingStartTurn = (pending: PendingStartTurn): QueuedMessage => ({
  thread_id: pending.thread_id,
  content: pending.content,
  mode: pending.mode,
})

const queueSubmittedMessageModel = (
  model: Model,
  queued: QueuedMessage,
  notice: string,
): readonly [Model, ReadonlyArray<AppCommand>] => [
  {
    ...model,
    draft: "",
    queued_messages: [...model.queued_messages, queued],
    typing_presence_cooling: false,
    notice,
  },
  [],
]

const conflictNotice = (activeUserId: Ids.UserId | undefined) =>
  activeUserId === undefined
    ? "Another turn is running - message queued"
    : `${activeUserId} is running a turn - message queued`

const presenceCommand = (model: Model, state: Remote.PresenceState): AppCommand | undefined =>
  model.selected_thread_id === undefined || model.user_id === undefined
    ? undefined
    : SetThreadPresence({
        api_base_url: model.api_base_url,
        thread_id: model.selected_thread_id,
        user_id: model.user_id,
        state,
      })

const receivedPresenceModel = (
  model: Model,
  presence: Remote.PresencePayload,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const threadId = model.subscribed_thread_id ?? model.selected_thread_id
  if (threadId !== undefined && presence.thread_id !== threadId) return [model, []]
  return [
    {
      ...model,
      presence: presence.users.filter((user) => model.user_id === undefined || user.user_id !== model.user_id),
    },
    [],
  ]
}

const interruptTurnModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_thread_id === undefined) return [model, []]
  const turnId = activeTurnId(model.events)
  if (turnId === undefined) return [model, []]
  if (model.pending_interrupt_turn_id === turnId) return [model, []]
  return [
    { ...model, pending_interrupt_turn_id: turnId, notice: undefined },
    [InterruptTurn({ api_base_url: model.api_base_url, thread_id: model.selected_thread_id, turn_id: turnId })],
  ]
}

const orbTabsModel = (model: Model, message: Tabs.Message): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [orb_tabs, commands, maybeOutMessage] = OrbTabs.update(model.orb_tabs, message)
  const selected_orb_tab = Option.match(maybeOutMessage, {
    onNone: () => model.selected_orb_tab,
    onSome: (outMessage) => (isOrbTab(outMessage.value) ? outMessage.value : model.selected_orb_tab),
  })
  const next = { ...model, selected_orb_tab, orb_tabs }
  const tabCommands = Command.mapMessages(commands, (childMessage) => GotOrbTabsMessage({ message: childMessage }))
  if (selected_orb_tab === "files" && model.selected_orb_tab !== "files") {
    const [loaded, loadCommands] = loadOrbDirectoryModel(next, "")
    return [loaded, [...tabCommands, ...loadCommands]]
  }
  if (selected_orb_tab === "changes" && model.selected_orb_tab !== "changes") {
    const [loaded, loadCommands] = loadOrbChangesModel(next)
    return [loaded, [...tabCommands, ...loadCommands]]
  }
  return [next, tabCommands]
}

const transcriptScrollerModel = (
  model: Model,
  message: MessageScroller.Message,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [transcript_scroller, commands] = MessageScroller.update(model.transcript_scroller, message)
  return [
    { ...model, transcript_scroller },
    Command.mapMessages(commands, (childMessage) => GotTranscriptScrollerMessage({ message: childMessage })),
  ]
}

const dialogWasClosed = (maybeOutMessage: Option.Option<AlertDialog.OutMessage>): boolean =>
  Option.match(maybeOutMessage, {
    onNone: () => false,
    onSome: (outMessage) => outMessage._tag === "Closed",
  })

const clickedKillOrbModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_orb === undefined) return [model, []]
  const [kill_orb_dialog, dialogCommands] = AlertDialog.open(model.kill_orb_dialog)
  return [
    {
      ...model,
      confirm_kill_orb_id: model.selected_orb.orb_id,
      kill_orb_dialog,
      notice: undefined,
    },
    Command.mapMessages(dialogCommands, (childMessage) => GotKillOrbDialogMessage({ message: childMessage })),
  ]
}

const killOrbDialogModel = (
  model: Model,
  message: AlertDialog.Message,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [kill_orb_dialog, dialogCommands, maybeOutMessage] = AlertDialog.update(model.kill_orb_dialog, message)
  return [
    {
      ...model,
      kill_orb_dialog,
      confirm_kill_orb_id: dialogWasClosed(maybeOutMessage) ? undefined : model.confirm_kill_orb_id,
    },
    Command.mapMessages(dialogCommands, (childMessage) => GotKillOrbDialogMessage({ message: childMessage })),
  ]
}

const cancelKillOrbModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [kill_orb_dialog, dialogCommands] = AlertDialog.close(model.kill_orb_dialog)
  return [
    { ...model, confirm_kill_orb_id: undefined, kill_orb_dialog, notice: undefined },
    Command.mapMessages(dialogCommands, (childMessage) => GotKillOrbDialogMessage({ message: childMessage })),
  ]
}

const receivedEventModel = (model: Model, event: Event.Event): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.subscribed_thread_id === undefined || event.thread_id !== model.subscribed_thread_id) return [model, []]
  if (event.sequence <= model.last_sequence) return [model, []]
  const terminalForPendingInterrupt =
    (event.type === "turn.completed" || event.type === "turn.failed") &&
    event.turn_id === model.pending_interrupt_turn_id
  const next = {
    ...model,
    events: [...model.events, event],
    last_sequence: event.sequence,
    connection: "connected" as const,
    pending_turn: event.type === "turn.completed" || event.type === "turn.failed" ? false : model.pending_turn,
    pending_interrupt_turn_id: terminalForPendingInterrupt ? undefined : model.pending_interrupt_turn_id,
  }
  return event.type === "turn.completed" || event.type === "turn.failed" ? drainQueuedMessagesModel(next) : [next, []]
}

const drainQueuedMessagesModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  const threadId = model.selected_thread_id
  if (threadId === undefined || activeTurnId(model.events) !== undefined) {
    return [model, []]
  }
  const queuedIndex = model.queued_messages.findIndex((message) => message.thread_id === threadId)
  const queued = model.queued_messages[queuedIndex]
  if (queued === undefined) return [model, []]
  const turnRequestToken = model.turn_request_token + 1
  const next = trackPendingStartTurn(
    {
      ...model,
      turn_request_token: turnRequestToken,
      active_turn_request_token: turnRequestToken,
      draft: "",
      queued_messages: model.queued_messages.filter((_, index) => index !== queuedIndex),
      pending_turn: true,
      pending_submit: queued.content,
      pending_submit_mode: queued.mode,
      notice: undefined,
    },
    {
      thread_id: threadId,
      request_token: turnRequestToken,
      content: queued.content,
      mode: queued.mode,
    },
  )
  const presence = presenceCommand(next, "active")
  return [
    next,
    [
      ...(presence === undefined ? [] : [presence]),
      StartTurn({
        api_base_url: model.api_base_url,
        thread_id: threadId,
        user_id: model.user_id,
        content: queued.content,
        mode: queued.mode,
        request_token: turnRequestToken,
      }),
    ],
  ]
}

const selectedOrbLoadedModel = (model: Model, orb: Remote.OrbSummary): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_thread_id !== orb.thread_id) return [model, []]
  const keepsPendingKill = model.confirm_kill_orb_id === orb.orb_id && orb.status !== "killed"
  const [kill_orb_dialog, dialogCommands] = keepsPendingKill
    ? ([model.kill_orb_dialog, []] as const)
    : AlertDialog.close(model.kill_orb_dialog)
  return [
    {
      ...model,
      selected_orb: orb,
      confirm_kill_orb_id: keepsPendingKill ? model.confirm_kill_orb_id : undefined,
      kill_orb_dialog,
      threads: updateThreadOrbStatus(model.threads, orb),
      notice: undefined,
    },
    Command.mapMessages(dialogCommands, (childMessage) => GotKillOrbDialogMessage({ message: childMessage })),
  ]
}

const selectedOrbActionModel = (
  model: Model,
  action: "pause" | "resume",
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_orb === undefined) return [model, []]
  const input = { api_base_url: model.api_base_url, orb_id: model.selected_orb.orb_id }
  return [
    { ...model, confirm_kill_orb_id: undefined, notice: undefined },
    [action === "pause" ? PauseSelectedOrb(input) : ResumeSelectedOrb(input)],
  ]
}

const confirmedKillOrbModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_orb === undefined || model.confirm_kill_orb_id !== model.selected_orb.orb_id) return [model, []]
  const [kill_orb_dialog, dialogCommands] = AlertDialog.close(model.kill_orb_dialog)
  return [
    { ...model, confirm_kill_orb_id: undefined, kill_orb_dialog, notice: undefined },
    [
      KillSelectedOrb({ api_base_url: model.api_base_url, orb_id: model.selected_orb.orb_id }),
      ...Command.mapMessages(dialogCommands, (childMessage) => GotKillOrbDialogMessage({ message: childMessage })),
    ],
  ]
}

const loadOrbDirectoryModel = (model: Model, path: string): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_thread_id === undefined || model.selected_orb === undefined) return [model, []]
  const state = model.orb_files.directories[path]
  if (state?.state === "loading" || state?.state === "loaded") return [model, []]
  const next = {
    ...model,
    orb_files: {
      ...model.orb_files,
      directories: { ...model.orb_files.directories, [path]: { state: "loading" as const } },
    },
    notice: undefined,
  }
  return [
    next,
    [
      ...pierreTreeUpdateCommands(next),
      LoadOrbDirectory({ api_base_url: model.api_base_url, thread_id: model.selected_thread_id, path }),
    ],
  ]
}

const loadOrbChangesModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_thread_id === undefined || model.selected_orb === undefined) return [model, []]
  if (model.orb_changes.state === "loading" || model.orb_changes.state === "loaded") return [model, []]
  return [
    { ...model, orb_changes: { state: "loading" }, notice: undefined },
    [LoadOrbChanges({ api_base_url: model.api_base_url, thread_id: model.selected_thread_id })],
  ]
}

const loadedOrbDirectoryModel = (
  model: Model,
  response: Remote.OrbFilesResponse,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const pathKinds = { ...model.orb_files.path_kinds }
  const treePaths = response.entries.map((entry) => {
    pathKinds[entry.path] = entry.kind
    return treePath(entry)
  })
  const next = {
    ...model,
    orb_files: {
      ...model.orb_files,
      directories: { ...model.orb_files.directories, [response.path]: { state: "loaded" as const } },
      paths: mergeTreePaths(model.orb_files.paths, treePaths),
      path_kinds: pathKinds,
    },
    notice: undefined,
  }
  return [next, pierreTreeUpdateCommands(next)]
}

const failedLoadOrbDirectoryModel = (
  model: Model,
  path: string,
  message: string,
): readonly [Model, ReadonlyArray<AppCommand>] => [
  {
    ...model,
    orb_files: {
      ...model.orb_files,
      directories: { ...model.orb_files.directories, [path]: { state: "failed", message } },
    },
    notice: message,
  },
  [],
]

const selectedOrbFileModel = (model: Model, path: string): readonly [Model, ReadonlyArray<AppCommand>] => {
  const normalized = normalizeTreeSelection(path)
  const kind = model.orb_files.path_kinds[normalized]
  if (kind === "dir") {
    const [next, commands] = loadOrbDirectoryModel(
      {
        ...model,
        orb_files: { ...model.orb_files, selected_path: normalized, opened_file: { state: "idle" } },
      },
      normalized,
    )
    return [next, commands]
  }
  if (model.selected_thread_id === undefined || model.selected_orb === undefined) return [model, []]
  const next = {
    ...model,
    orb_files: {
      ...model.orb_files,
      selected_path: normalized,
      opened_file: { state: "loading" as const, path: normalized },
    },
    notice: undefined,
  }
  return [
    next,
    [
      ...pierreTreeUpdateCommands(next),
      LoadOrbFile({ api_base_url: model.api_base_url, thread_id: model.selected_thread_id, path: normalized }),
    ],
  ]
}

const loadedOrbFileModel = (
  model: Model,
  response: Remote.OrbFileResponse,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.orb_files.selected_path !== response.path) return [model, []]
  return [
    {
      ...model,
      orb_files: {
        ...model.orb_files,
        opened_file:
          response.kind === "text"
            ? { state: "text", path: response.path, content: response.content, truncated: response.truncated }
            : { state: "binary", path: response.path },
      },
      notice: undefined,
    },
    [],
  ]
}

const failedLoadOrbFileModel = (
  model: Model,
  path: string,
  message: string,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.orb_files.selected_path !== path) return [model, []]
  return [
    {
      ...model,
      orb_files: { ...model.orb_files, opened_file: { state: "failed", path, message } },
      notice: message,
    },
    [],
  ]
}

const loadedOrbChangesModel = (
  model: Model,
  response: Remote.OrbChangesResponse,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const parsed = parseOrbChanges(response)
  const next = {
    ...model,
    orb_changes: parsed,
    orb_files: {
      ...model.orb_files,
      git_status: parsed.state === "loaded" ? gitStatusFromOrbChanges(parsed.diffs) : [],
    },
    notice: parsed.state === "failed" ? parsed.message : undefined,
  }
  return [next, pierreTreeUpdateCommands(next)]
}

const parseOrbChanges = (response: Remote.OrbChangesResponse): OrbChangesModel => {
  try {
    const patches = response.diff.trim().length === 0 ? [] : parsePatchFiles(response.diff, "orb-changes", false)
    const parsedFileNames = new Set<string>()
    const diffs = patches.flatMap((patch, patchIndex) =>
      patch.files.map((fileDiff, fileIndex): OrbChangeRow => {
        parsedFileNames.add(fileDiff.name)
        const payloadId = `orb-changes:${patchIndex}:${fileIndex}`
        if (fileDiff.hunks.length === 0) {
          return {
            kind: "skipped",
            payload_id: payloadId,
            file_name: fileDiff.name,
            reason: "No renderable hunks",
            git_status: gitStatusFromFileDiff(fileDiff),
          }
        }
        return {
          kind: "diff",
          ...toWebPierreDiffFromFileDiff(fileDiff, payloadId),
          git_status: gitStatusFromFileDiff(fileDiff),
        }
      }),
    )
    const skipped = diffFileEntries(response.diff)
      .filter((entry) => !parsedFileNames.has(entry.file_name))
      .map(
        (entry, index): OrbChangeSkipped => ({
          kind: "skipped",
          payload_id: `orb-changes:skipped:${index}`,
          file_name: entry.file_name,
          reason: "Diff unavailable",
          git_status: entry.git_status,
        }),
      )
    return {
      state: "loaded",
      base_commit: response.base_commit,
      head_commit: response.head_commit,
      dirty: response.dirty,
      diffs: [...diffs, ...skipped],
    }
  } catch (cause) {
    const skipped = diffFileEntries(response.diff).map(
      (entry, index): OrbChangeSkipped => ({
        kind: "skipped",
        payload_id: `orb-changes:skipped:${index}`,
        file_name: entry.file_name,
        reason: cause instanceof Error ? cause.message : String(cause),
        git_status: entry.git_status,
      }),
    )
    if (skipped.length > 0) {
      return {
        state: "loaded",
        base_commit: response.base_commit,
        head_commit: response.head_commit,
        dirty: response.dirty,
        diffs: skipped,
      }
    }
    return { state: "failed", message: cause instanceof Error ? cause.message : String(cause) }
  }
}

interface DiffFileEntry {
  readonly file_name: string
  readonly git_status: PierreTreeGitStatusEntry
}

const diffFileEntries = (diff: string): ReadonlyArray<DiffFileEntry> => {
  const entries: Array<DiffFileEntry> = []
  let current: DiffFileEntry | undefined
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (match?.[2] !== undefined) {
      if (current !== undefined) entries.push(current)
      current = { file_name: match[2], git_status: { path: match[2], status: "modified" } }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith("new file mode ") || line === "--- /dev/null") {
      current = { ...current, git_status: { path: current.file_name, status: "added" } }
      continue
    }
    if (line.startsWith("deleted file mode ") || line === "+++ /dev/null") {
      current = { ...current, git_status: { path: current.file_name, status: "deleted" } }
      continue
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      current = { ...current, git_status: { path: current.file_name, status: "renamed" } }
    }
  }
  if (current !== undefined) entries.push(current)
  return entries
}

const treePath = (entry: Remote.OrbFileEntry) => (entry.kind === "dir" ? `${entry.path}/` : entry.path)

const mergeTreePaths = (current: ReadonlyArray<string>, next: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set([...current, ...next])].toSorted(compareTreePaths)

const compareTreePaths = (left: string, right: string) => {
  const leftDir = left.endsWith("/")
  const rightDir = right.endsWith("/")
  if (leftDir !== rightDir) return leftDir ? -1 : 1
  return left.localeCompare(right)
}

const normalizeTreeSelection = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "")
  return normalized === "." ? "" : normalized
}

export const pierreTreeMountKey = (threadId: Ids.ThreadId, orbId: Ids.OrbId): string => `orb-tree:${threadId}:${orbId}`

const pierreTreeUpdateCommands = (model: Model): ReadonlyArray<AppCommand> => {
  const args = pierreTreeCommandArgs(model)
  return args === undefined ? [] : [UpdatePierreTree(args)]
}

const pierreTreeCommandArgs = (model: Model) => {
  if (model.selected_orb_tab !== "files") return undefined
  if (model.selected_thread_id === undefined || model.selected_orb === undefined) return undefined
  if (model.orb_files.paths.length === 0) return undefined
  const selected = selectedTreePath(model.orb_files)
  return {
    mount_key: pierreTreeMountKey(model.selected_thread_id, model.selected_orb.orb_id),
    paths: model.orb_files.paths,
    git_status: model.orb_files.git_status,
    ...(selected === undefined ? {} : { selected_path: selected }),
  }
}

const selectedTreePath = (orbFiles: OrbFilesModel) => {
  const selected = orbFiles.selected_path
  if (selected === undefined) return undefined
  return orbFiles.path_kinds[selected] === "dir" ? `${selected}/` : selected
}

const gitStatusFromOrbChanges = (diffs: ReadonlyArray<OrbChangeRow>): ReadonlyArray<PierreTreeGitStatusEntry> => {
  const entries = new Map<string, PierreTreeGitStatusEntry>()
  for (const diff of diffs) entries.set(diff.git_status.path, diff.git_status)
  return [...entries.values()]
}

const gitStatusFromFileDiff = (fileDiff: PierreDiff.FileDiffMetadata): PierreTreeGitStatusEntry => ({
  path: fileDiff.name,
  status: gitStatusFromFileDiffType(fileDiff.type),
})

const gitStatusFromFileDiffType = (type: PierreDiff.FileDiffChangeType): PierreTreeGitStatus => {
  if (type === "new") return "added"
  if (type === "deleted") return "deleted"
  if (type === "rename-pure" || type === "rename-changed") return "renamed"
  return "modified"
}

const updateThreadOrbStatus = (
  threads: ReadonlyArray<Remote.ThreadSummary>,
  orb: Remote.OrbSummary,
): ReadonlyArray<Remote.ThreadSummary> =>
  threads.map((thread) => (thread.thread_id === orb.thread_id ? { ...thread, orb_status: orb.status } : thread))

const newestFirst = (threads: ReadonlyArray<Remote.ThreadSummary>): ReadonlyArray<Remote.ThreadSummary> =>
  threads.toSorted((left, right) => right.updated_at - left.updated_at)

const lastEventSequence = (events: ReadonlyArray<Event.Event>) => events.at(-1)?.sequence ?? 0

const initialOrbWorkspace = () => ({
  selected_orb_tab: "transcript" as const,
  orb_tabs: Tabs.init({ id: "orb-tabs" }),
  transcript_scroller: MessageScroller.init({ id: "transcript-scroller" }),
  kill_orb_dialog: AlertDialog.init({ id: "kill-orb-dialog" }),
  orb_files: initialOrbFiles(),
  orb_changes: { state: "idle" as const },
  orb_terminal_status: "idle" as const,
  orb_terminal_error: undefined,
})

const initialOrbFiles = (): OrbFilesModel => ({
  directories: {},
  paths: [],
  path_kinds: {},
  git_status: [],
  opened_file: { state: "idle" },
})

const diffRows = (input: {
  readonly eventId: string
  readonly sequence: number
  readonly title: string
  readonly fallbackKind: TextTranscriptRow["kind"]
  readonly value:
    | Event.ToolCallCompleted["data"]["result"]["output"]
    | Event.ArtifactCreated["data"]["artifact"]["content"]
  readonly expandedDiffIds: ReadonlySet<string>
  readonly collapsedTranscriptRowIds: ReadonlySet<string>
}): ReadonlyArray<TranscriptRow> | undefined => {
  const payloads = collectPierreDiffPayloads(input.value)
  if (payloads.length === 0) return undefined
  return payloads.map((payload, index) => {
    const payloadId = `${input.eventId}:diff:${index}`
    const diff = toWebPierreDiff(payload, payloadId)
    if (diff === undefined) {
      const unavailableId = `${input.eventId}:diff-unavailable:${index}`
      const fileName = payloadFileName(payload)
      return {
        id: unavailableId,
        sequence: input.sequence,
        kind: input.fallbackKind,
        title: input.title,
        body: fileName === undefined ? "diff unavailable" : `${fileName} · diff unavailable`,
        is_open: !input.collapsedTranscriptRowIds.has(unavailableId),
      }
    }
    return {
      id: payloadId,
      sequence: input.sequence,
      kind: "pierre-diff",
      title: input.title,
      diff,
      expanded: input.expandedDiffIds.has(payloadId),
    }
  })
}

const toggleString = (values: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value]

const agentModeFromValue = (value: string): Remote.AgentMode | undefined =>
  value === "rush" || value === "smart" || value === "deep1" || value === "deep2" || value === "deep3"
    ? value
    : undefined

const isOrbTab = (value: string): value is OrbTab =>
  value === "transcript" || value === "files" || value === "changes" || value === "terminal"

const unreachableEventRow = (_event: never): TranscriptRow => ({
  id: "unreachable",
  sequence: 0,
  kind: "event",
  title: "Unknown event",
  body: "",
})

const roleLabel = (role: RikaMessage.Role) => {
  if (role === "assistant") return "Rika"
  if (role === "user") return "User"
  if (role === "tool") return "Tool"
  return "System"
}

const messageAuthor = (
  message: RikaMessage.Message,
  userId: Ids.UserId | undefined,
): TextTranscriptRow["author"] | undefined => {
  const messageUserId = messageUserIdFromMetadata(message)
  if (message.role !== "user" || messageUserId === undefined) return undefined
  const isLocal = userId !== undefined && messageUserId === userId
  return {
    label: isLocal ? "User" : messageUserId,
    is_local: isLocal,
  }
}

const messageUserIdFromMetadata = (message: RikaMessage.Message): Ids.UserId | undefined => {
  const value = message.metadata?.user_id
  return typeof value === "string" ? Ids.UserId.make(value) : undefined
}
