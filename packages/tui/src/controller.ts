import { Config } from "@rika/core"
import { Event, Ids, Message, Remote } from "@rika/schema"
import { Cause, Effect, Fiber, Queue, Schema, Stream } from "effect"
import type { Dirent } from "node:fs"
import { stat } from "node:fs/promises"
import { readdir, readFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { splitCommand, splitFirst } from "./backend"
import type {
  CommandResult,
  PresenceRequest,
  ProjectOption,
  SessionBackend,
  ThreadOption,
  TurnRequest,
} from "./backend"
import * as Adapter from "./adapter"
import * as Keymap from "./keymap"
import * as Keys from "./keys"
import * as Palette from "./palette"
import * as ViewState from "./view-state"

export interface RunInput extends Schema.Schema.Type<typeof RunInput> {}
export const RunInput = Schema.Struct({
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  workspace_id: Schema.optional(Ids.WorkspaceId),
  thread_id: Schema.optional(Ids.ThreadId),
  user_id: Schema.optional(Ids.UserId),
}).annotate({ identifier: "Rika.Tui.Controller.RunInput" })

export interface Dependencies<E> {
  readonly backend: SessionBackend<E>
  readonly renderer: Adapter.Adapter
  readonly ticks: Stream.Stream<void>
  readonly defaultMode: Config.Mode
  readonly defaultWorkspace: string
  readonly keymap?: Keymap.EffectiveKeymap
}

type AppEvent =
  | { readonly _tag: "Key"; readonly key: Keys.Key }
  | { readonly _tag: "Ui"; readonly action: Adapter.Action }
  | { readonly _tag: "Tick" }
  | { readonly _tag: "ModelBatch"; readonly events: ReadonlyArray<Event.Event> }
  | { readonly _tag: "Presence"; readonly presence: Remote.PresencePayload }
  | { readonly _tag: "ThreadPreviewLoaded"; readonly thread_id: Ids.ThreadId; readonly preview: ViewState.ViewState }
  | { readonly _tag: "ThreadPreviewFailed"; readonly thread_id: Ids.ThreadId; readonly message: string }
  | { readonly _tag: "ThreadEventsFailed"; readonly message: string }
  | { readonly _tag: "TurnEnded"; readonly token: number; readonly submitted?: SubmittedTurn; readonly error?: unknown }
  | { readonly _tag: "Resize" }
  | { readonly _tag: "KeysDone" }

type SubmittedTurn = Pick<TurnRequest, "content" | "content_parts">

const modelEventBatchSize = 64
const modelEventBatchWindow = "16 millis"
const typingHeartbeatTicks = 40

export const run = <E>(deps: Dependencies<E>, input: RunInput): Effect.Effect<number, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspacePath = input.workspace_root ?? deps.defaultWorkspace
      let workspaceId = input.workspace_id ?? Ids.WorkspaceId.make(workspacePath)
      let mode = input.mode ?? deps.defaultMode
      const userId = input.user_id

      if (input.thread_id === undefined) {
        yield* deps.renderer.render(
          ViewState.initial({
            thread_id: Ids.ThreadId.make("pending"),
            workspace_path: workspacePath,
            mode,
            ...(userId === undefined ? {} : { user_id: userId }),
          }),
        )
      }

      const loaded = yield* deps.backend
        .loadInitial({
          ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
          workspace_path: workspacePath,
          workspace_id: workspaceId,
          mode,
          ...(userId === undefined ? {} : { user_id: userId }),
        })
        .pipe(Effect.catchCause((cause) => freshThread(deps, workspacePath, mode, userId, Cause.squash(cause))))

      const keymap = deps.keymap ?? Keymap.defaultEffectiveKeymap
      const keymapWarning = Keymap.warningLine(keymap.warnings)
      let state = ViewState.withGitBranch(loaded.state, yield* resolveGitBranch(workspacePath))
      if (keymapWarning !== undefined) state = ViewState.withNotice(state, keymapWarning)
      let threadId = loaded.thread_id

      let pending: Keymap.Pending | undefined
      let active = false
      let quitRequested = false
      let keysDone = false
      let exitCode = 0
      let turnToken = 0
      let turnFiber: Fiber.Fiber<void> | undefined
      let threadEventsFiber: Fiber.Fiber<void> | undefined
      let currentTurnId: Ids.TurnId | undefined
      let activeThreadId: Ids.ThreadId | undefined
      let lastSequence = loaded.last_sequence ?? 0
      let typingCooldownTicks = 0
      let typingAnnounced = false

      const queue = yield* Queue.unbounded<AppEvent, Cause.Done>()
      const render = () => deps.renderer.render(state)
      const useThreadEvents = deps.backend.submitTurn !== undefined && deps.backend.subscribeThreadEvents !== undefined

      const restartThreadEvents = (nextThreadId: Ids.ThreadId, afterSequence: number) =>
        Effect.gen(function* () {
          if (deps.backend.subscribeThreadEvents === undefined) return
          if (threadEventsFiber !== undefined && (activeThreadId === undefined || activeThreadId === nextThreadId)) {
            yield* Effect.sync(() => threadEventsFiber?.interruptUnsafe())
          }
          threadEventsFiber = yield* Effect.forkScoped(
            deps.backend
              .subscribeThreadEvents({
                thread_id: nextThreadId,
                after_sequence: afterSequence,
                ...(userId === undefined ? {} : { user_id: userId }),
                onPresence: (presence) => Queue.offerUnsafe(queue, { _tag: "Presence", presence }),
              })
              .pipe(
                Stream.groupedWithin(modelEventBatchSize, modelEventBatchWindow),
                Stream.runForEach((events) => Queue.offer(queue, { _tag: "ModelBatch", events }).pipe(Effect.asVoid)),
                Effect.catchCause((cause) =>
                  Queue.offer(queue, { _tag: "ThreadEventsFailed", message: errorMessage(Cause.squash(cause)) }).pipe(
                    Effect.asVoid,
                  ),
                ),
              ),
          )
        })

      const maybeShutdown = () =>
        Effect.gen(function* () {
          if (active) return
          if (quitRequested || (keysDone && state.queued.length === 0)) {
            yield* Queue.end(queue)
          }
        })

      const startTurn = (submitted: SubmittedTurn) =>
        Effect.gen(function* () {
          active = true
          turnToken += 1
          const token = turnToken
          currentTurnId = undefined
          activeThreadId = threadId
          state = { ...state, active: true, activity: "idle" }
          const request = {
            thread_id: threadId,
            workspace_path: workspacePath,
            workspace_id: workspaceId,
            ...(userId === undefined ? {} : { user_id: userId }),
            ...submitted,
            mode,
            fast_mode: state.fast_mode,
          }
          if (deps.backend.submitTurn === undefined) {
            turnFiber = yield* Effect.forkScoped(
              deps.backend.streamTurn(request).pipe(
                Stream.groupedWithin(modelEventBatchSize, modelEventBatchWindow),
                Stream.runForEach((events) => Queue.offer(queue, { _tag: "ModelBatch", events }).pipe(Effect.asVoid)),
                Effect.matchCauseEffect({
                  onFailure: (cause: Cause.Cause<E>) =>
                    Queue.offer(queue, { _tag: "TurnEnded", token, submitted, error: Cause.squash(cause) }).pipe(
                      Effect.asVoid,
                    ),
                  onSuccess: () => Queue.offer(queue, { _tag: "TurnEnded", token, submitted }).pipe(Effect.asVoid),
                }),
              ),
            )
          } else {
            turnFiber = undefined
            yield* deps.backend
              .submitTurn(request)
              .pipe(
                Effect.catchCause((cause: Cause.Cause<E>) =>
                  Queue.offer(queue, { _tag: "TurnEnded", token, submitted, error: Cause.squash(cause) }).pipe(
                    Effect.asVoid,
                  ),
                ),
              )
          }
          yield* render()
        })

      const drainQueuedTurn = () =>
        Effect.gen(function* () {
          const dequeued = ViewState.dequeueMessage(state)
          state = dequeued.state
          if (dequeued.next !== undefined) {
            if (dequeued.next.startsWith("/")) yield* runSlash(dequeued.next)
            else yield* startTurn({ content: dequeued.next })
          }
        })

      const toggleRemoteArm = () => {
        const next = ViewState.toggleRemoteArm(state)
        state = ViewState.withNotice(
          next,
          next.remoteArm.enabled ? "Orb-backed thread creation armed." : "Orb-backed thread creation disarmed.",
        )
      }

      const loadProjects = (): Effect.Effect<ReadonlyArray<ProjectOption>> =>
        deps.backend.listProjects === undefined
          ? Effect.sync(() => {
              state = ViewState.withNotice(state, "Project commands are unavailable in this backend.")
              return []
            })
          : deps.backend.listProjects({ workspace_path: workspacePath }).pipe(
              Effect.catchCause((cause: Cause.Cause<E>) =>
                Effect.sync(() => {
                  state = ViewState.withNotice(state, `Project list failed: ${errorMessage(Cause.squash(cause))}`)
                  return []
                }),
              ),
            )

      const selectProject = (projectName: string | undefined) =>
        Effect.gen(function* () {
          const projects = yield* loadProjects()
          if (deps.backend.listProjects === undefined) return
          if (projectName === undefined || projectName.trim().length === 0) {
            const names = projects.map((project) => project.name).join(", ")
            state = ViewState.withNotice(
              state,
              names.length === 0 ? "No projects found." : `Projects: ${names}. Use /project select <name>.`,
            )
            return
          }
          const project = projects.find(
            (candidate) => candidate.name === projectName || candidate.project_id === projectName,
          )
          state =
            project === undefined
              ? ViewState.withNotice(state, `Project not found: ${projectName}`)
              : ViewState.withNotice(
                  ViewState.withRemoteProject(state, project.name),
                  `Project selected: ${project.name}`,
                )
        })

      const createProject = (projectName: string | undefined) =>
        Effect.gen(function* () {
          if (deps.backend.createProject === undefined) {
            state = ViewState.withNotice(state, "Project creation is unavailable in this backend.")
            return
          }
          if (projectName === undefined || projectName.trim().length === 0) {
            state = ViewState.withNotice(state, "Usage: /project create <name>")
            return
          }
          const repoOrigin = yield* currentGitRemoteOrigin(workspacePath).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                state = ViewState.withNotice(state, `Git origin lookup failed: ${errorMessage(Cause.squash(cause))}`)
                return undefined
              }),
            ),
          )
          if (repoOrigin === undefined) return
          const project = yield* deps.backend.createProject({ name: projectName, repo_origin: repoOrigin }).pipe(
            Effect.catchCause((cause: Cause.Cause<E>) =>
              Effect.sync(() => {
                state = ViewState.withNotice(state, `Project creation failed: ${errorMessage(Cause.squash(cause))}`)
                return undefined
              }),
            ),
          )
          if (project === undefined) return
          state = ViewState.withNotice(
            ViewState.withRemoteProject(state, project.name),
            `Project created: ${project.name}`,
          )
        })

      const provisionOrbThread = () =>
        Effect.gen(function* () {
          if (!state.remoteArm.enabled) return false
          if (active) {
            state = ViewState.withNotice(state, "Finish or interrupt the current turn before creating an orb thread.")
            return true
          }
          if (deps.backend.createOrbThread === undefined) {
            state = ViewState.withNotice(state, "Orb-backed thread creation is unavailable in this backend.")
            return true
          }
          const selectedProjectName = state.remoteArm.project_name
          if (selectedProjectName === undefined) {
            state = ViewState.withNotice(state, "Select a project before creating an orb-backed thread.")
            return true
          }
          const projects = yield* loadProjects()
          const project = projects.find(
            (candidate) => candidate.name === selectedProjectName || candidate.project_id === selectedProjectName,
          )
          if (project === undefined) {
            state = ViewState.withNotice(state, `Project not found: ${selectedProjectName}`)
            return true
          }
          state = ViewState.withSystemCard(state, {
            id: "orb-provisioning",
            title: "Orb provisioning",
            subtitle: project.name,
          })
          yield* render()
          const created = yield* deps.backend
            .createOrbThread({ project_id: project.project_id, workspace_path: workspacePath, mode })
            .pipe(
              Effect.catchCause((cause: Cause.Cause<E>) =>
                Effect.sync(() => {
                  state = ViewState.withNotice(state, `Orb provisioning failed: ${errorMessage(Cause.squash(cause))}`)
                  return undefined
                }),
              ),
            )
          if (created === undefined) return true
          const previousBranch = state.git_branch
          let next = ViewState.withThread(state, {
            thread_id: created.thread_id,
            events: [],
            notice: `Orb-backed thread ready: ${project.name}`,
            ...(created.active_orb === undefined ? {} : { active_orb: created.active_orb }),
          })
          next = ViewState.withRemoteArm(next, { enabled: false, project_name: project.name })
          if (previousBranch !== undefined) next = ViewState.withGitBranch(next, previousBranch)
          state = ViewState.withSystemCard(next, {
            id: "orb-provisioning",
            title: "Orb provisioned",
            subtitle: project.name,
          })
          threadId = created.thread_id
          workspaceId = created.workspace_id
          typingCooldownTicks = 0
          typingAnnounced = false
          lastSequence = 0
          yield* restartThreadEvents(threadId, lastSequence)
          return true
        })

      const runLocalSlash = (command: string) =>
        Effect.gen(function* () {
          const [name, argument] = splitCommand(command)
          if (name === "/orb") {
            if (argument === "toggle") {
              toggleRemoteArm()
              return true
            }
            if (argument === "pause" || argument === "resume" || argument === "kill") return false
            state = ViewState.withNotice(state, "Usage: /orb toggle|pause|resume|kill")
            return true
          }
          if (name === "/project") {
            const [operation, value] = splitFirst(argument ?? "")
            if (operation === "select") {
              yield* selectProject(value)
              return true
            }
            if (operation === "create") {
              yield* createProject(value)
              return true
            }
            state = ViewState.withNotice(state, "Usage: /project select <name> or /project create <name>")
            return true
          }
          if (name === "/new") return yield* provisionOrbThread()
          return false
        })

      const runSlash = (command: string) =>
        Effect.gen(function* () {
          const handled = yield* runLocalSlash(command)
          if (handled) {
            yield* render()
            return
          }
          if (command.startsWith("/thread ")) {
            state = ViewState.beginConnecting(state)
            yield* render()
          }
          const commandState = active ? { ...state, active: true } : state
          const result = yield* deps.backend
            .runCommand(
              {
                state: commandState,
                thread_id: threadId,
                workspace_path: workspacePath,
                workspace_id: workspaceId,
                mode,
              },
              command,
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.succeed<CommandResult>({
                  state: ViewState.withNotice(commandState, `Command failed: ${errorMessage(Cause.squash(cause))}`),
                  thread_id: threadId,
                  last_sequence: lastSequence,
                  mode,
                  exit: false,
                }),
              ),
            )
          state = active ? { ...result.state, active: true } : result.state
          const previousThreadId = threadId
          threadId = result.thread_id
          if (result.last_sequence !== undefined) lastSequence = result.last_sequence
          mode = result.mode
          if (threadId !== previousThreadId) yield* restartThreadEvents(threadId, lastSequence)
          if (result.exit) {
            quitRequested = true
            exitCode = 0
          }
          yield* render()
        })

      const openThreadSwitcher = () =>
        Effect.gen(function* () {
          const threads = yield* deps.backend
            .listThreads({ workspace_path: workspacePath, workspace_id: workspaceId })
            .pipe(Effect.catchCause(() => Effect.succeed([])))
          state = ViewState.openThreadSwitcher(state, threads.map(threadSwitcherItem))
          yield* render()
          yield* ensureSelectedThreadPreview()
        })

      const ensureSelectedThreadPreview = () =>
        Effect.gen(function* () {
          const thread = ViewState.selectedThreadSwitcherItem(state)
          if (thread === undefined) return
          if (thread.preview_state.status === "loading" || thread.preview_state.status === "ready") return
          state = ViewState.threadSwitcherPreviewLoading(state, thread.thread_id)
          yield* render()
          yield* Effect.forkScoped(
            deps.backend
              .loadThreadPreview({
                thread_id: thread.thread_id,
                workspace_path: workspacePath,
                workspace_id: workspaceId,
                mode,
              })
              .pipe(
                Effect.matchCauseEffect({
                  onFailure: (cause: Cause.Cause<E>) =>
                    Queue.offer(queue, {
                      _tag: "ThreadPreviewFailed",
                      thread_id: thread.thread_id,
                      message: errorMessage(Cause.squash(cause)),
                    }).pipe(Effect.asVoid),
                  onSuccess: (preview) =>
                    Queue.offer(queue, {
                      _tag: "ThreadPreviewLoaded",
                      thread_id: thread.thread_id,
                      preview: preview.state,
                    }).pipe(Effect.asVoid),
                }),
              ),
          )
        })

      const submit = () =>
        Effect.gen(function* () {
          const submitted = yield* submittedTurn(state, workspacePath)
          const raw = submitted.content
          const trimmed = raw.trim()
          state = ViewState.clearInput(state)
          yield* syncTypingPresence()
          if (trimmed.length === 0) {
            yield* render()
            return
          }
          state = ViewState.pushHistory(state, trimmed)
          if (trimmed.startsWith("/")) {
            yield* runSlash(trimmed)
            yield* maybeShutdown()
            return
          }
          if (active) {
            state = ViewState.enqueueMessage(state, trimmed)
            yield* render()
            return
          }
          yield* startTurn({ ...submitted, content: trimmed })
        })

      const forceInterrupt = () =>
        Effect.gen(function* () {
          if (!active) {
            state = ViewState.withNotice(state, "Nothing to interrupt.")
            yield* render()
            return
          }
          const fiber = turnFiber
          const turnId = currentTurnId
          const cancelThreadId = activeThreadId ?? threadId
          active = false
          turnToken += 1
          turnFiber = undefined
          activeThreadId = undefined
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
          if (turnId !== undefined) {
            yield* deps.backend
              .cancelTurn({ thread_id: cancelThreadId, turn_id: turnId })
              .pipe(Effect.catchCause(() => Effect.void))
          }
          state = ViewState.withNotice(
            { ...ViewState.clearQueuedMessages(state), active: false, activity: "idle", streaming_text: "" },
            "Interrupted the running turn.",
          )
          yield* render()
          yield* maybeShutdown()
        })

      const openModePicker = () =>
        Effect.gen(function* () {
          if (ViewState.modeLocked(state)) {
            state = ViewState.withNotice(state, "Mode is locked once a thread is active.")
            yield* render()
            return
          }
          state = ViewState.openModePicker(state)
          yield* render()
        })

      const cycleModePicker = (delta: number) =>
        Effect.gen(function* () {
          state = ViewState.modePickerApply(ViewState.modePickerMove(state, delta))
          mode = state.mode
          yield* render()
        })

      const applyAction = (action: Keymap.Action) =>
        Effect.gen(function* () {
          switch (action._tag) {
            case "Insert":
              state = yield* insertTextOrImageAttachment(state, workspacePath, action.text)
              break
            case "Paste":
              state = yield* insertPasteOrImageAttachment(state, workspacePath, action.text)
              break
            case "Backspace":
              state = ViewState.backspace(state)
              break
            case "DeleteForward":
              state = ViewState.deleteForward(state)
              break
            case "DeleteWordBackward":
              state = ViewState.deleteWordBackward(state)
              break
            case "DeleteWordForward":
              state = ViewState.deleteWordForward(state)
              break
            case "DeleteToLineStart":
              state = ViewState.deleteToLineStart(state)
              break
            case "DeleteToLineEnd":
              state = ViewState.deleteToLineEnd(state)
              break
            case "Newline":
              state = ViewState.newline(state)
              break
            case "CursorLeft":
              state = ViewState.moveCursorLeft(state)
              break
            case "CursorRight":
              state = ViewState.moveCursorRight(state)
              break
            case "CursorHome":
              state = ViewState.moveCursorHome(state)
              break
            case "CursorEnd":
              state = ViewState.moveCursorEnd(state)
              break
            case "WordLeft":
              state = ViewState.moveWordLeft(state)
              break
            case "WordRight":
              state = ViewState.moveWordRight(state)
              break
            case "FocusPrev":
              state = state.queued.length > 0 ? ViewState.queueUp(state) : ViewState.focusPrev(state)
              break
            case "FocusNext":
              state = state.queued.length > 0 ? ViewState.queueDown(state) : ViewState.focusNext(state)
              break
            case "OpenPalette":
              state = ViewState.openPalette(state)
              break
            case "ClosePalette":
              state = ViewState.closePalette(state)
              break
            case "PaletteUp":
              state = ViewState.paletteMove(
                state,
                -1,
                Palette.filter(state.palette.query, state.mode, state.fast_mode, {
                  threadActive: ViewState.hasActivity(state),
                  orbBackedThread: ViewState.hasActiveOrb(state),
                }).length,
              )
              break
            case "PaletteDown":
              state = ViewState.paletteMove(
                state,
                1,
                Palette.filter(state.palette.query, state.mode, state.fast_mode, {
                  threadActive: ViewState.hasActivity(state),
                  orbBackedThread: ViewState.hasActiveOrb(state),
                }).length,
              )
              break
            case "PaletteInsert":
              state = ViewState.paletteInsert(state, action.text)
              break
            case "PaletteBackspace":
              state = ViewState.paletteBackspace(state)
              break
            case "PaletteRun": {
              const command = Palette.at(state.palette.query, state.palette.selected, state.mode, state.fast_mode, {
                threadActive: ViewState.hasActivity(state),
                orbBackedThread: ViewState.hasActiveOrb(state),
              })
              state = ViewState.closePalette(state)
              if (command !== undefined) {
                if (command.command === "/switch-thread") {
                  yield* openThreadSwitcher()
                  return
                }
                yield* runSlash(command.command)
                yield* maybeShutdown()
                return
              }
              break
            }
            case "OpenShortcuts":
              state = ViewState.openShortcuts(state)
              break
            case "CloseOverlay":
              state = ViewState.closeShortcuts(state)
              break
            case "OpenModePicker":
              yield* openModePicker()
              return
            case "ModePickerNext":
              yield* cycleModePicker(1)
              return
            case "ModePickerPrev":
              yield* cycleModePicker(-1)
              return
            case "ModePickerClose":
              state = ViewState.closeModePicker(state)
              break
            case "ToggleDetails":
              state = ViewState.toggleDetails(state)
              break
            case "CycleReasoning":
              state = ViewState.cycleReasoning(state)
              mode = state.mode
              break
            case "ToggleFastMode":
              state = ViewState.isFastEligible(state.mode)
                ? ViewState.toggleFastMode(state)
                : ViewState.withNotice(state, "Fast speed is only available in rush and deep modes.")
              break
            case "ToggleRemoteArm":
              toggleRemoteArm()
              break
            case "OpenEditor": {
              const edited = yield* deps.renderer.editExternally(ViewState.submitText(state))
              state = ViewState.insertText(ViewState.clearInput(state), edited)
              break
            }
            case "PasteImage": {
              const path = yield* deps.renderer.pasteImage(workspacePath)
              state =
                path === undefined
                  ? ViewState.withNotice(state, "No image in clipboard.")
                  : ViewState.withNotice(ViewState.insertImageAttachment(state, path), "Pasted image attached.")
              break
            }
            case "FileMention": {
              const files = yield* listWorkspaceFiles(workspacePath)
              state = ViewState.openFilePicker(state, files)
              break
            }
            case "Steer": {
              const steering = ViewState.submitText(state).trim()
              state = ViewState.clearInput(state)
              yield* syncTypingPresence()
              if (steering.length > 0) state = ViewState.enqueueMessage(state, steering)
              state = ViewState.promoteSelectedOrNextQueued(state)
              break
            }
            case "DequeueSelected":
              state = ViewState.dequeueSelected(state)
              break
            case "HistoryPrev":
              state = ViewState.historyPrev(state)
              break
            case "NavPrevMessage":
              state = ViewState.navPrevMessage(state)
              break
            case "NavNextMessage":
              state = ViewState.navNextMessage(state)
              break
            case "EditMessage":
              state = ViewState.editNavMessage(state)
              break
            case "Submit":
              state = yield* convertTrailingImagePath(state, workspacePath)
              yield* submit()
              return
            case "ForceInterrupt":
              yield* forceInterrupt()
              return
            case "Quit":
              quitRequested = true
              exitCode = 0
              state = ViewState.withNotice(state, "Goodbye.")
              yield* render()
              yield* maybeShutdown()
              return
            case "ArchiveNew":
              yield* runSlash("/archive")
              yield* runSlash("/new")
              return
            case "ArchiveQuit":
              yield* runSlash("/archive")
              quitRequested = true
              exitCode = 0
              yield* render()
              yield* maybeShutdown()
              return
          }
          yield* syncTypingPresence()
          yield* render()
        })

      const setPresence = (presenceState: PresenceRequest["state"]) =>
        userId === undefined || deps.backend.setThreadPresence === undefined
          ? Effect.void
          : deps.backend
              .setThreadPresence({ thread_id: threadId, user_id: userId, state: presenceState })
              .pipe(Effect.catchCause(() => Effect.void))

      const syncTypingPresence = () =>
        Effect.gen(function* () {
          const pendingInput = ViewState.submitText(state).trim().length > 0
          if (!pendingInput) {
            if (typingAnnounced) {
              yield* setPresence("active")
              typingAnnounced = false
            }
            typingCooldownTicks = 0
            return
          }
          if (typingCooldownTicks > 0) return
          yield* setPresence("typing")
          typingAnnounced = true
          typingCooldownTicks = typingHeartbeatTicks
        })

      const handleThreadSwitcherKey = (key: Keys.Key) =>
        Effect.gen(function* () {
          const threads = ViewState.filteredThreadSwitcherItems(state)
          if (key.name === "escape") state = ViewState.closeThreadSwitcher(state)
          else if (key.name === "return") {
            const thread = threads[state.threadswitcher.selected]
            state = ViewState.closeThreadSwitcher(state)
            if (thread !== undefined) {
              yield* runSlash(`/thread ${thread.thread_id}`)
              yield* maybeShutdown()
              return
            }
          } else if (key.name === "up") {
            state = ViewState.threadSwitcherMove(state, -1, threads.length)
            yield* render()
            yield* ensureSelectedThreadPreview()
            return
          } else if (key.name === "down") {
            state = ViewState.threadSwitcherMove(state, 1, threads.length)
            yield* render()
            yield* ensureSelectedThreadPreview()
            return
          } else if (key.name === "backspace") {
            state =
              state.threadswitcher.query.length === 0
                ? ViewState.closeThreadSwitcher(state)
                : ViewState.threadSwitcherBackspace(state)
          } else if (Keys.isPrintable(key)) state = ViewState.threadSwitcherInsert(state, Keys.char(key))
          yield* render()
          if (state.threadswitcher.open) yield* ensureSelectedThreadPreview()
        })

      const handleFilePickerKey = (key: Keys.Key) =>
        Effect.gen(function* () {
          const files = ViewState.filteredFiles(state)
          if (key.name === "escape") state = ViewState.closeFilePicker(state)
          else if (key.name === "return") state = ViewState.acceptSelected(state)
          else if (key.name === "up") state = ViewState.filePickerMove(state, -1, files.length)
          else if (key.name === "down") state = ViewState.filePickerMove(state, 1, files.length)
          else if (key.name === "backspace") {
            state =
              state.filepicker.query.length === 0
                ? ViewState.closeFilePicker(state)
                : ViewState.filePickerBackspace(state)
          } else if (
            Keys.isPrintable(key) &&
            Keys.char(key) === "@" &&
            state.filepicker.kind === "file" &&
            state.filepicker.query.length === 0
          ) {
            const threads = yield* deps.backend
              .listThreads({ workspace_path: workspacePath, workspace_id: workspaceId })
              .pipe(Effect.catchCause(() => Effect.succeed([])))
            state = ViewState.openThreadPicker(
              state,
              threads.map((thread) => ({ label: thread.label, insert: thread.thread_id })),
            )
          } else if (Keys.isPrintable(key)) state = ViewState.filePickerInsert(state, Keys.char(key))
          yield* render()
        })

      const handleKey = (key: Keys.Key) =>
        Effect.gen(function* () {
          if (state.threadswitcher.open) {
            yield* handleThreadSwitcherKey(key)
            return
          }
          if (state.filepicker.open) {
            yield* handleFilePickerKey(key)
            return
          }
          const context: Keymap.Context = {
            surface: state.modepicker.open
              ? "modepicker"
              : state.palette.open
                ? "palette"
                : state.shortcuts_open
                  ? "overlay"
                  : "input",
            busy: active,
            inputEmpty: state.input.text.length === 0,
            trailingBackslash: state.input.text.endsWith("\\"),
            queueSelected: state.queue_selected >= 0,
            navigating: state.nav_index >= 0,
          }
          const resolution = Keymap.resolve(context, pending, key, keymap)
          if (resolution._tag === "Pending") {
            pending = resolution.chord
            return
          }
          if (resolution._tag === "Ignore") {
            pending = undefined
            return
          }
          pending = resolution.action._tag === "Submit" ? "enter" : undefined
          yield* applyAction(resolution.action)
        })

      const handleTurnEnded = (token: number, submitted: SubmittedTurn | undefined, error: unknown) =>
        Effect.gen(function* () {
          if (token !== turnToken) return
          active = false
          turnFiber = undefined
          currentTurnId = undefined
          activeThreadId = undefined
          const activeUserId = activeUserIdFromError(error)
          if (activeUserId !== undefined && submitted !== undefined) {
            state = ViewState.withNotice(
              ViewState.enqueueMessage(ViewState.finishTurn(state), submitted.content.trim()),
              `${activeUserId} is running a turn — message queued`,
            )
            yield* render()
            yield* maybeShutdown()
            return
          }
          state = ViewState.finishTurn(state, error === undefined ? "idle" : "failed")
          if (error !== undefined) state = ViewState.withNotice(state, `Turn failed: ${errorMessage(error)}`)
          yield* drainQueuedTurn()
          yield* render()
          yield* maybeShutdown()
        })

      const handleUiAction = (action: Adapter.Action) =>
        Effect.gen(function* () {
          switch (action._tag) {
            case "ToggleCard":
              state = ViewState.toggleCard(state, action.card_id)
              break
            case "ToggleToolGroup":
              state = ViewState.toggleToolGroup(state)
              break
            case "OpenFile": {
              yield* deps.renderer
                .openFile({
                  workspace_path: workspacePath,
                  path: action.path,
                  ...(action.range === undefined ? {} : { range: action.range }),
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => {
                      state = ViewState.withNotice(state, `File open failed: ${errorMessage(Cause.squash(cause))}`)
                    }),
                  ),
                )
              break
            }
          }
          yield* render()
        })

      const handle = (appEvent: AppEvent) =>
        Effect.gen(function* () {
          switch (appEvent._tag) {
            case "Tick":
              state = ViewState.tickSpinner(state)
              if (typingCooldownTicks > 0) typingCooldownTicks -= 1
              yield* syncTypingPresence()
              yield* render()
              return
            case "Resize":
              yield* render()
              return
            case "ModelBatch":
              let endedTurn = false
              for (const event of appEvent.events) {
                if (useThreadEvents) {
                  const belongsToVisibleThread = event.thread_id === threadId
                  const belongsToActiveTurn = activeThreadId !== undefined && event.thread_id === activeThreadId
                  if (!belongsToVisibleThread && !belongsToActiveTurn) continue
                  if (belongsToVisibleThread) {
                    if (event.sequence <= lastSequence) continue
                    lastSequence = event.sequence
                  }
                }
                state = ViewState.applyEvent(state, event)
                if (event.type === "turn.started") {
                  active = true
                  currentTurnId = event.turn_id
                  activeThreadId = event.thread_id
                }
                if (
                  (event.type === "turn.completed" || event.type === "turn.failed") &&
                  (currentTurnId === undefined || event.turn_id === currentTurnId)
                ) {
                  active = false
                  turnFiber = undefined
                  currentTurnId = undefined
                  activeThreadId = undefined
                  endedTurn = true
                }
              }
              if (endedTurn && useThreadEvents) {
                yield* drainQueuedTurn()
                yield* maybeShutdown()
              }
              yield* render()
              return
            case "Presence":
              state = ViewState.withPresence(state, appEvent.presence)
              yield* render()
              return
            case "ThreadPreviewLoaded":
              state = ViewState.threadSwitcherPreviewReady(state, appEvent.thread_id, appEvent.preview)
              yield* render()
              return
            case "ThreadPreviewFailed":
              state = ViewState.threadSwitcherPreviewFailed(state, appEvent.thread_id, appEvent.message)
              yield* render()
              return
            case "ThreadEventsFailed":
              state = ViewState.withNotice(state, `Thread sync failed: ${appEvent.message}`)
              yield* render()
              return
            case "TurnEnded":
              yield* handleTurnEnded(appEvent.token, appEvent.submitted, appEvent.error)
              return
            case "KeysDone":
              keysDone = true
              yield* maybeShutdown()
              return
            case "Ui":
              yield* handleUiAction(appEvent.action)
              return
            case "Key":
              yield* handleKey(appEvent.key)
              return
          }
        })

      yield* Effect.forkScoped(
        deps.renderer.actions.pipe(
          Stream.runForEach((action) => Queue.offer(queue, { _tag: "Ui", action }).pipe(Effect.asVoid)),
        ),
      )
      yield* Effect.forkScoped(
        deps.renderer.keys.pipe(
          Stream.runForEach((key) => Queue.offer(queue, { _tag: "Key", key }).pipe(Effect.asVoid)),
          Effect.andThen(Queue.offer(queue, { _tag: "KeysDone" }).pipe(Effect.asVoid)),
        ),
      )
      yield* Effect.forkScoped(
        deps.ticks.pipe(Stream.runForEach(() => Queue.offer(queue, { _tag: "Tick" }).pipe(Effect.asVoid))),
      )
      yield* Effect.forkScoped(
        deps.renderer.resizes.pipe(Stream.runForEach(() => Queue.offer(queue, { _tag: "Resize" }).pipe(Effect.asVoid))),
      )
      yield* restartThreadEvents(threadId, lastSequence)

      yield* render()
      yield* Stream.fromQueue(queue).pipe(Stream.runForEach(handle))
      yield* deps.renderer.setExit({
        thread_id: threadId,
        workspace_path: workspacePath,
        title: firstUserMessage(state),
      })
      return exitCode
    }),
  )

const freshThread = <E>(
  _deps: Dependencies<E>,
  workspacePath: string,
  mode: Config.Mode,
  userId: Ids.UserId | undefined,
  _cause: unknown,
) =>
  Effect.sync(() => {
    const threadId = Ids.ThreadId.make(`thread_${Date.now()}`)
    return {
      thread_id: threadId,
      state: ViewState.initial({
        thread_id: threadId,
        workspace_path: workspacePath,
        mode,
        events: [],
        ...(userId === undefined ? {} : { user_id: userId }),
      }),
      last_sequence: 0,
    }
  })

const submittedTurn = (state: ViewState.ViewState, workspacePath: string): Effect.Effect<SubmittedTurn> =>
  Effect.gen(function* () {
    const content = ViewState.submitText(state)
    const parts = ViewState.submitInputParts(state)
    if (!parts.some((part) => part.type === "image")) return { content }
    const contentParts = yield* Effect.forEach(parts, (part) => submittedContentPart(part, workspacePath))
    return { content, content_parts: contentParts }
  })

const submittedContentPart = (
  part: ViewState.SubmittedInputPart,
  workspacePath: string,
): Effect.Effect<Message.ContentPart> => {
  if (part.type === "text") return Effect.succeed(Message.text(part.text))
  const path = absolutePath(part.path) ? part.path : join(workspacePath, part.path)
  return Effect.tryPromise(() => readFile(path)).pipe(
    Effect.map(
      (bytes): Message.ImagePart => ({
        type: "image",
        media_type: imageMediaType(part.path),
        data: Buffer.from(bytes).toString("base64"),
        filename: part.path,
        metadata: { label: part.text },
      }),
    ),
    Effect.catch(() => Effect.succeed(Message.text(part.text))),
  )
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".rika", ".turbo", ".next", "build", "coverage"])

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".heic"])

const imageMediaType = (path: string): string => {
  const ext = extname(path).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"
  return "application/octet-stream"
}

const insertTextOrImageAttachment = (
  state: ViewState.ViewState,
  workspacePath: string,
  text: string,
): Effect.Effect<ViewState.ViewState> =>
  Effect.gen(function* () {
    const path = singleImagePath(text)
    if (path === undefined) return ViewState.insertText(state, text)
    const relativePath = absolutePath(path) ? relative(workspacePath, path) : path
    const exists = yield* fileExists(absolutePath(path) ? path : join(workspacePath, path))
    return exists ? ViewState.insertImageAttachment(state, relativePath) : ViewState.insertText(state, text)
  })

const insertPasteOrImageAttachment = (
  state: ViewState.ViewState,
  workspacePath: string,
  text: string,
): Effect.Effect<ViewState.ViewState> =>
  Effect.gen(function* () {
    const path = singleImagePath(text)
    if (path !== undefined) {
      const relativePath = absolutePath(path) ? relative(workspacePath, path) : path
      const exists = yield* fileExists(absolutePath(path) ? path : join(workspacePath, path))
      if (exists) return ViewState.insertImageAttachment(state, relativePath)
    }
    return collapsiblePaste(text) ? ViewState.insertPastedText(state, text) : ViewState.insertText(state, text)
  })

const collapsiblePaste = (text: string): boolean => text.includes("\n") || text.includes("\r") || text.length > 120

const convertTrailingImagePath = (
  state: ViewState.ViewState,
  workspacePath: string,
): Effect.Effect<ViewState.ViewState> =>
  Effect.gen(function* () {
    if (state.input.attachments.some((attachment) => attachment.kind === "image")) return state
    const path = trailingImagePath(state.input.text)
    if (path === undefined) return state
    const relativePath = absolutePath(path) ? relative(workspacePath, path) : path
    const exists = yield* fileExists(absolutePath(path) ? path : join(workspacePath, path))
    if (!exists) return state
    const before = state.input.text.slice(0, state.input.text.length - path.length)
    return ViewState.insertImageAttachment(
      { ...state, input: { ...state.input, text: before, cursor: before.length, attachments: [] } },
      relativePath,
    )
  })

const trailingImagePath = (text: string): string | undefined => {
  const match = /(?:^|\s)(\S+\.(?:png|jpe?g|gif|webp|bmp|tiff|heic))$/i.exec(text.trimEnd())
  return match?.[1]
}

const singleImagePath = (text: string): string | undefined => {
  const trimmed = text.trim()
  const path = normalizedPastedPath(trimmed)
  if (path === undefined || path.length === 0) return undefined
  const lower = path.toLowerCase()
  for (const extension of imageExtensions) {
    if (lower.endsWith(extension)) return path
  }
  return undefined
}

const normalizedPastedPath = (value: string): string | undefined => {
  const unquoted = stripWrappingQuotes(value)
  const path = unquoted.startsWith("file://") ? fileUrlPath(unquoted) : unquoted
  return path === undefined ? undefined : unescapePastedPath(path)
}

const stripWrappingQuotes = (value: string): string => {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  return (first === "'" && last === "'") || (first === '"' && last === '"') ? value.slice(1, -1) : value
}

const unescapePastedPath = (value: string): string => value.replace(/\\([\\ ()[\]{}'"&;!$`*?|<>#~])/g, "$1")

const fileUrlPath = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : undefined
  } catch {
    return undefined
  }
}

const absolutePath = (path: string): boolean => path.startsWith("/")

const fileExists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  })

const listWorkspaceFiles = (root: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(async () => {
    const out: Array<string> = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= 3000 || depth > 8) return
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= 3000) return
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1)
        } else if (entry.isFile()) {
          out.push(relative(root, full))
        }
      }
    }
    await walk(root, 0)
    out.sort()
    return out
  })

const resolveGitBranch = (root: string): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    try {
      const head = await readFile(join(root, ".git", "HEAD"), "utf8")
      const match = head.trim().match(/^ref: refs\/heads\/(.+)$/)
      return match === null ? undefined : match[1]
    } catch {
      return undefined
    }
  })

const currentGitRemoteOrigin = (root: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const subprocess = Bun.spawn(["git", "remote", "get-url", "origin"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ])
      const origin = stdout.trim()
      if (exitCode !== 0 || origin.length === 0) throw new Error(stderr.trim() || "origin remote is not configured")
      return origin
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const firstUserMessage = (state: ViewState.ViewState): string => {
  const entry = state.entries.find((item) => item.kind === "message" && item.message.role === "user")
  if (entry === undefined || entry.kind !== "message") return ""
  const text = entry.message.text.trim().replace(/\s+/g, " ")
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

const threadSwitcherItem = (option: ThreadOption): ViewState.ThreadSwitcherItem => ({
  thread_id: option.thread_id,
  title: option.title,
  preview: option.preview,
  updated_label: option.updated_label,
  archived: option.archived,
  ...(option.orb_status === undefined ? {} : { orb_status: option.orb_status }),
  ...(option.diff === undefined ? {} : { diff: option.diff }),
  preview_state: { status: "unloaded" },
})

const errorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { readonly message: unknown }).message
    if (typeof message === "string") return message
  }
  return String(value)
}

const activeUserIdFromError = (value: unknown): Ids.UserId | undefined => {
  if (typeof value !== "object" || value === null || !("active_user_id" in value)) return undefined
  const activeUserId = (value as { readonly active_user_id?: unknown }).active_user_id
  return typeof activeUserId === "string" ? Ids.UserId.make(activeUserId) : undefined
}
