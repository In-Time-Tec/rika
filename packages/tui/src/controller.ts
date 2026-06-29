import { Config } from "@rika/core"
import { Event, Ids } from "@rika/schema"
import { Cause, Effect, Fiber, Queue, Schema, Stream } from "effect"
import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { SessionBackend } from "./backend"
import * as Adapter from "./adapter"
import * as Keymap from "./keymap"
import * as Keys from "./keys"
import * as Palette from "./palette"
import * as ViewState from "./view-state"

export interface RunInput extends Schema.Schema.Type<typeof RunInput> {}
export const RunInput = Schema.Struct({
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Tui.Controller.RunInput" })

export interface Dependencies<E> {
  readonly backend: SessionBackend<E>
  readonly renderer: Adapter.Adapter
  readonly ticks: Stream.Stream<void>
  readonly defaultMode: Config.Mode
  readonly defaultWorkspace: string
}

type AppEvent =
  | { readonly _tag: "Key"; readonly key: Keys.Key }
  | { readonly _tag: "Ui"; readonly action: Adapter.Action }
  | { readonly _tag: "Tick" }
  | { readonly _tag: "Model"; readonly event: Event.Event }
  | { readonly _tag: "TurnEnded"; readonly token: number; readonly error?: unknown }
  | { readonly _tag: "Resize" }
  | { readonly _tag: "KeysDone" }

export const run = <E>(deps: Dependencies<E>, input: RunInput): Effect.Effect<number, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspacePath = input.workspace_root ?? deps.defaultWorkspace
      let mode = input.mode ?? deps.defaultMode

      const loaded = yield* deps.backend
        .loadInitial({
          ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
          workspace_path: workspacePath,
          mode,
        })
        .pipe(Effect.catchCause((cause) => freshThread(deps, workspacePath, mode, Cause.squash(cause))))

      let state = ViewState.withGitBranch(loaded.state, yield* resolveGitBranch(workspacePath))
      let threadId = loaded.thread_id

      let pending: Keymap.Pending | undefined
      let active = false
      let quitRequested = false
      let keysDone = false
      let exitCode = 0
      let turnToken = 0
      let turnFiber: Fiber.Fiber<void> | undefined
      let currentTurnId: Ids.TurnId | undefined

      const queue = yield* Queue.unbounded<AppEvent, Cause.Done>()
      const render = () => deps.renderer.render(state)

      const maybeShutdown = () =>
        Effect.gen(function* () {
          if (active) return
          if (quitRequested || (keysDone && state.queued.length === 0)) {
            yield* Queue.end(queue)
          }
        })

      const startTurn = (content: string) =>
        Effect.gen(function* () {
          active = true
          turnToken += 1
          const token = turnToken
          currentTurnId = undefined
          const fiber = yield* Effect.forkScoped(
            deps.backend.streamTurn({ thread_id: threadId, workspace_path: workspacePath, content, mode }).pipe(
              Stream.runForEach((event) => Queue.offer(queue, { _tag: "Model", event }).pipe(Effect.asVoid)),
              Effect.matchCauseEffect({
                onFailure: (cause: Cause.Cause<E>) =>
                  Queue.offer(queue, { _tag: "TurnEnded", token, error: Cause.squash(cause) }).pipe(Effect.asVoid),
                onSuccess: () => Queue.offer(queue, { _tag: "TurnEnded", token }).pipe(Effect.asVoid),
              }),
            ),
          )
          turnFiber = fiber
          yield* render()
        })

      const runSlash = (command: string) =>
        Effect.gen(function* () {
          const result = yield* deps.backend
            .runCommand({ state, thread_id: threadId, workspace_path: workspacePath, mode }, command)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.succeed({
                  state: ViewState.withNotice(state, `Command failed: ${errorMessage(Cause.squash(cause))}`),
                  thread_id: threadId,
                  mode,
                  exit: false,
                }),
              ),
            )
          state = result.state
          threadId = result.thread_id
          mode = result.mode
          if (result.exit) {
            quitRequested = true
            exitCode = 0
          }
          yield* render()
        })

      const submit = () =>
        Effect.gen(function* () {
          const raw = state.input.text
          const trimmed = raw.trim()
          state = ViewState.clearInput(state)
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
          yield* startTurn(trimmed)
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
          active = false
          turnToken += 1
          turnFiber = undefined
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
          if (turnId !== undefined) {
            yield* deps.backend
              .cancelTurn({ thread_id: threadId, turn_id: turnId })
              .pipe(Effect.catchCause(() => Effect.void))
          }
          state = { ...ViewState.withNotice(state, "Interrupted the running turn."), queued: [] }
          yield* render()
          yield* maybeShutdown()
        })

      const switchMode = () =>
        Effect.gen(function* () {
          if (ViewState.hasActivity(state)) {
            state = ViewState.withNotice(state, "Mode is locked once a thread is active.")
            yield* render()
            return
          }
          mode = nextMode(mode)
          state = ViewState.withNotice(ViewState.withMode(state, mode), `Mode switched to ${mode}`)
          yield* render()
        })

      const applyAction = (action: Keymap.Action) =>
        Effect.gen(function* () {
          switch (action._tag) {
            case "Insert":
              state = ViewState.insertText(state, action.text)
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
              state = ViewState.paletteMove(state, -1, Palette.filter(state.palette.query).length)
              break
            case "PaletteDown":
              state = ViewState.paletteMove(state, 1, Palette.filter(state.palette.query).length)
              break
            case "PaletteInsert":
              state = ViewState.paletteInsert(state, action.text)
              break
            case "PaletteBackspace":
              state = ViewState.paletteBackspace(state)
              break
            case "PaletteRun": {
              const command = Palette.at(state.palette.query, state.palette.selected)
              state = ViewState.closePalette(state)
              if (command !== undefined) {
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
            case "SwitchMode":
              yield* switchMode()
              return
            case "ToggleDetails":
              state = ViewState.toggleDetails(state)
              break
            case "CycleReasoning":
              state = ViewState.cycleReasoning(state)
              break
            case "ToggleFastMode":
              state = ViewState.toggleFastMode(state)
              break
            case "OpenEditor": {
              const edited = yield* deps.renderer.editExternally(state.input.text)
              state = ViewState.insertText(ViewState.clearInput(state), edited)
              break
            }
            case "PasteImage": {
              const path = yield* deps.renderer.pasteImage(workspacePath)
              state =
                path === undefined
                  ? ViewState.withNotice(state, "No image in clipboard.")
                  : ViewState.withNotice(ViewState.insertText(state, `@${path} `), "Pasted image attached.")
              break
            }
            case "FileMention": {
              const files = yield* listWorkspaceFiles(workspacePath)
              state = ViewState.openFilePicker(state, files)
              break
            }
            case "Steer": {
              const selected = ViewState.selectedQueued(state)
              if (selected !== undefined) {
                const removed = ViewState.dequeueSelected(state)
                state = ViewState.withNotice(
                  { ...removed, queued: [selected, ...removed.queued], queue_selected: -1 },
                  "Steering — moved to the front of the queue.",
                )
              } else {
                if (state.input.text.trim().length > 0) state = ViewState.enqueueMessage(state, state.input.text.trim())
                state = ViewState.withNotice(
                  ViewState.clearInput(state),
                  "Steering message queued for the running turn.",
                )
              }
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
          yield* render()
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
              .listThreads({ workspace_path: workspacePath })
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
          if (state.filepicker.open) {
            yield* handleFilePickerKey(key)
            return
          }
          const context: Keymap.Context = {
            surface: state.palette.open ? "palette" : state.shortcuts_open ? "overlay" : "input",
            busy: active,
            inputEmpty: state.input.text.length === 0,
            trailingBackslash: state.input.text.endsWith("\\"),
            queueSelected: state.queue_selected >= 0,
            navigating: state.nav_index >= 0,
          }
          const resolution = Keymap.resolve(context, pending, key)
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

      const handleTurnEnded = (token: number, error: unknown) =>
        Effect.gen(function* () {
          if (token !== turnToken) return
          active = false
          turnFiber = undefined
          currentTurnId = undefined
          if (error !== undefined) state = ViewState.withNotice(state, `Turn failed: ${errorMessage(error)}`)
          const dequeued = ViewState.dequeueMessage(state)
          state = dequeued.state
          if (dequeued.next !== undefined) {
            if (dequeued.next.startsWith("/")) yield* runSlash(dequeued.next)
            else yield* startTurn(dequeued.next)
          }
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
          }
          yield* render()
        })

      const handle = (appEvent: AppEvent) =>
        Effect.gen(function* () {
          switch (appEvent._tag) {
            case "Tick":
              state = ViewState.tickSpinner(state)
              yield* render()
              return
            case "Resize":
              yield* render()
              return
            case "Model":
              state = ViewState.applyEvent(state, appEvent.event)
              if (appEvent.event.type === "turn.started") currentTurnId = appEvent.event.turn_id
              yield* render()
              return
            case "TurnEnded":
              yield* handleTurnEnded(appEvent.token, appEvent.error)
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

const freshThread = <E>(_deps: Dependencies<E>, workspacePath: string, mode: Config.Mode, _cause: unknown) =>
  Effect.sync(() => {
    const threadId = Ids.ThreadId.make(`thread_${Date.now()}`)
    return {
      thread_id: threadId,
      state: ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode, events: [] }),
    }
  })

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".rika", ".turbo", ".next", "build", "coverage"])

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

const firstUserMessage = (state: ViewState.ViewState): string => {
  const entry = state.entries.find((item) => item.kind === "message" && item.message.role === "user")
  if (entry === undefined || entry.kind !== "message") return ""
  const text = entry.message.text.trim().replace(/\s+/g, " ")
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

const nextMode = (mode: Config.Mode): Config.Mode => {
  if (mode === "rush") return "smart"
  if (mode === "smart") return "deep"
  return "rush"
}

const errorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { readonly message: unknown }).message
    if (typeof message === "string") return message
  }
  return String(value)
}
