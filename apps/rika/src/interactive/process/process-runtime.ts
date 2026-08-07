import * as BunServices from "@effect/platform-bun/BunServices"
import * as ProcessFiles from "./process-files"
import * as ProcessLifecycle from "./process-lifecycle"
import * as ProcessPrompt from "./process-prompt"
import * as ProcessWorkspace from "./process-workspace"
import * as ProcessLayer from "./process-layer"
import { paletteCommand } from "../controller/interactive-palette-controller"
import { classifyPrompt, displayInput, promptParts } from "@rika/terminal/terminal-session"
import { execute, type Action, type Adapter, type ModelTuning } from "@rika/terminal/terminal-session"
import { update } from "@rika/terminal/terminal-state-reducer"
import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
import type { Model, Mode } from "@rika/terminal/terminal-state"
type PromptPart = ReturnType<ReturnType<typeof promptParts>>[number]
import type { ThreadItem } from "@rika/terminal/terminal-state"
import * as Thread from "@rika/product/thread-record"
import * as ProductOperation from "@rika/product/product-operation"
import { Cause, Clock, Effect, Fiber, FileSystem, Schema } from "effect"
import * as Logging from "../../diagnostics/diagnostic-file-logging"
import { workspaceDirectory } from "@rika/configuration/configuration-paths"
import { renderGoodbye } from "../input/goodbye-message"
import type { InteractiveRuntimeContext } from "./interactive-runtime-context"

type Runtime = InteractiveRuntimeContext
const provideLayerScoped = ProcessLayer.provideLayerScoped
const noopSelectionResync = (_threadId: string) => undefined
const mkdir = ProcessFiles.mkdir
const rm = ProcessFiles.rm
const childExit = ProcessWorkspace.childExit
const resolveLocalFileImpl = ProcessFiles.resolveLocalFileImpl
const readChangedFilesEffect = ProcessWorkspace.readChangedFilesEffect
const refreshChangedFilesOn = ProcessWorkspace.refreshChangedFilesOn
const defaultOpenArguments = ProcessFiles.defaultOpenArguments
const editorArguments = ProcessFiles.editorArguments
const materializePromptParts = ProcessPrompt.materializePromptParts
const quitStopWorkBound = ProcessLifecycle.quitStopWorkBound
const interruptTrackedFibers = ProcessLifecycle.interruptTrackedFibers
const tuiSignalExitCode = ProcessLifecycle.tuiSignalExitCode

export const makeProcessRuntime = (runtime: Runtime) => {
  const { loop, fork, session, options, recoverSession, resume } = runtime
  let requestSelectionResync: (threadId: string) => void = noopSelectionResync
  const pauseTerminal = () => {
    if (loop.closed) return () => false
    if (loop.terminalPauseCount === 0)
      try {
        loop.renderer?.suspendTerminal()
      } catch (cause) {
        close(1)
        throw cause
      }
    loop.terminalPauseCount += 1
    let released = false
    return () => {
      if (released) return false
      released = true
      loop.terminalPauseCount = Math.max(0, loop.terminalPauseCount - 1)
      if (loop.closed || loop.terminalPauseCount > 0) return false
      try {
        loop.renderer?.resumeTerminal()
      } catch (cause) {
        close(1)
        throw cause
      }
      return true
    }
  }
  const goodbye = () => {
    const threadId = loop.model.currentThreadId
    const threadTitle =
      loop.model.currentThreadTitle ??
      (loop.model.threads as ReadonlyArray<ThreadItem>).find((thread) => thread.id === threadId)?.title
    try {
      process.stdout.write(
        renderGoodbye({
          mode: loop.model.mode,
          workspace: loop.model.workspace,
          ...(threadId === undefined ? {} : { threadId }),
          ...(threadTitle === undefined ? {} : { threadTitle }),
        }),
      )
    } catch {
      return
    }
  }
  const teardown = (showGoodbye: boolean) =>
    Effect.suspend(() => {
      if (loop.teardownStarted) return Effect.void
      loop.teardownStarted = true
      return Effect.gen(function* () {
        yield* Effect.logInfo("tui.teardown.started")
        loop.closed = true
        process.off("SIGINT", interrupt)
        process.off("SIGTERM", terminate)
        process.off("SIGHUP", hangup)
        process.off("SIGTSTP", suspend)
        process.off("SIGCONT", continueFromSuspend)
        process.stdin.off("end", hangup)
        process.stdin.off("error", hangup)
        process.stdin.off("close", hangup)
        if (loop.previewTimer !== undefined) yield* Fiber.interrupt(loop.previewTimer)
        loop.previewTimer = undefined
        if (loop.renderTimer !== undefined) yield* Fiber.interrupt(loop.renderTimer)
        loop.renderTimer = undefined
        if (loop.feedTimer !== undefined) yield* Fiber.interrupt(loop.feedTimer)
        loop.feedTimer = undefined
        Logging.settleActiveLogs()
        loop.renderer?.releaseTerminal()
        if (loop.initialization !== undefined) yield* Fiber.await(loop.initialization)
        yield* interruptTrackedFibers([...loop.fibers])
        if (showGoodbye) goodbye()
        yield* Effect.logInfo("tui.teardown.completed")
      })
    })
  const close = (exitCode?: number, showGoodbye = true) => {
    if (loop.closing) return
    loop.closing = true
    if (exitCode !== undefined) process.exitCode = exitCode
    fork(
      session.quit.pipe(
        Effect.timeoutOrElse({
          duration: quitStopWorkBound,
          orElse: () => Effect.logWarning("tui.quit.stop_work.timeout"),
        }),
        Effect.catch((failure) =>
          Effect.logWarning("tui.quit.stop_work.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failure instanceof Error ? failure.name : "unknown"),
          ),
        ),
        Effect.andThen(teardown(showGoodbye)),
        Effect.andThen(Effect.sync(() => resume(Effect.void))),
      ),
    )
  }
  const interrupt = () => {
    if (
      !loop.interruptCancellationRequested &&
      (loop.submittedSinceIdle ||
        loop.model.busy ||
        loop.model.activeTurnId !== undefined ||
        loop.model.activity !== undefined)
    ) {
      loop.interruptCancellationRequested = true
      run(session.cancel)
      return
    }
    close(tuiSignalExitCode("SIGINT"))
  }
  const terminate = () => close(tuiSignalExitCode("SIGTERM"))
  const hangup = () => close(tuiSignalExitCode("SIGHUP"), false)
  const suspend = () => {
    if (loop.closed || loop.pendingJobControlPause || loop.releaseJobControlPause !== undefined) return
    if (loop.renderer === undefined) {
      loop.pendingJobControlPause = true
      return
    }
    try {
      loop.releaseJobControlPause = pauseTerminal()
      process.kill(process.pid, "SIGSTOP")
    } catch {
      loop.releaseJobControlPause?.()
      loop.releaseJobControlPause = undefined
      close(1)
    }
  }
  const continueFromSuspend = () => {
    if (loop.pendingJobControlPause) {
      loop.pendingJobControlPause = false
      return
    }
    if (loop.closed || loop.releaseJobControlPause === undefined) return
    const release = loop.releaseJobControlPause
    loop.releaseJobControlPause = undefined
    try {
      if (release()) loop.renderer?.surface.update(loop.model)
    } catch {
      close(1)
    }
  }
  process.on("SIGINT", interrupt)
  process.once("SIGTERM", terminate)
  process.on("SIGHUP", hangup)
  process.stdin.once("end", hangup)
  process.stdin.once("error", hangup)
  process.stdin.once("close", hangup)
  process.on("SIGTSTP", suspend)
  process.on("SIGCONT", continueFromSuspend)
  const submit = (
    prompt: string,
    parts: ReadonlyArray<PromptPart>,
    mode: Mode,
    tuning?: ModelTuning,
    submissionId?: string,
  ) => {
    const classified = classifyPrompt(prompt)
    const effect =
      classified._tag === "Shell"
        ? session.shell(
            loop.model.currentThreadId === undefined ? undefined : Thread.ThreadId.make(loop.model.currentThreadId),
            classified.command,
            classified.incognito,
          )
        : materializePromptParts(parts, loop.model.workspace).pipe(
            Effect.flatMap((materialized) =>
              session.submit(classified.prompt, mode, materialized, tuning, submissionId),
            ),
            Effect.catchIf(
              (failure): failure is ProcessPrompt.PromptAttachmentError =>
                Schema.is(ProcessPrompt.PromptAttachmentError)(failure),
              (failure) =>
                Effect.sync(() => {
                  let restored: Model = {
                    ...loop.model,
                    input: "",
                    cursor: 0,
                    pastedText: [],
                    busy: false,
                    activity: undefined,
                  }
                  for (const [index, part] of parts.entries()) {
                    if (part.type === "image") {
                      if (index !== failure.index)
                        restored = update(restored, { _tag: "ImageInserted", path: part.path })
                    } else {
                      restored = {
                        ...restored,
                        input:
                          restored.input.slice(0, restored.cursor) + part.text + restored.input.slice(restored.cursor),
                        cursor: restored.cursor + part.text.length,
                      }
                    }
                  }
                  loop.model = update(restored, { _tag: "ExecutionFailed", message: failure.message })
                  loop.renderer?.surface.update(loop.model)
                }),
            ),
          )
    const fiber = effect.pipe(provideLayerScoped(BunServices.layer), recoverSession, fork)
    loop.fibers.add(fiber)
    fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => loop.fibers.delete(fiber)))))
  }
  const run = <E>(effect: Effect.Effect<void, E, BunServices.BunServices>) => {
    const fiber = fork(
      effect.pipe(
        provideLayerScoped(BunServices.layer),
        Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))),
      ),
    )
    loop.fibers.add(fiber)
    fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => loop.fibers.delete(fiber)))))
  }
  const requestNewerPage = () => {
    const threadId = loop.model.currentThreadId
    if (
      !loop.transcriptHasNewer ||
      loop.pendingNewer !== undefined ||
      loop.transcriptNewestCursor === undefined ||
      threadId === undefined
    )
      return
    const cursor = loop.transcriptNewestCursor
    loop.pendingNewer = { threadId, cursor: JSON.stringify(cursor) }
    run(
      session.loadNewer(threadId, cursor).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            loop.pendingNewer = undefined
          }),
        ),
      ),
    )
  }
  const loadSelected = (effect: Effect.Effect<void, ProductOperation.OperationUnavailable>, generation: number) =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        if (generation !== loop.selectionGeneration) return
        loop.model = update(loop.model, { _tag: "ThreadOpenRequested" })
        loop.renderer?.surface.update(loop.model)
      })
      yield* effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (generation !== loop.selectionGeneration) return
            loop.model = update(loop.model, { _tag: "ThreadOpenCompleted" })
            if (loop.renderer !== undefined) loop.renderer.surface.update(loop.model)
          }),
        ),
      )
    })
  const startSelection = (select: () => Effect.Effect<void, ProductOperation.OperationUnavailable>) => {
    const generation = (loop.selectionGeneration += 1)
    const previous = loop.selectionFiber
    let selectedFiber: Fiber.Fiber<void, never>
    selectedFiber = fork(
      (previous === undefined ? Effect.void : Fiber.interrupt(previous)).pipe(
        Effect.andThen(recoverSession(loadSelected(select(), generation))),
        Effect.ensuring(
          Effect.sync(() => {
            loop.fibers.delete(selectedFiber)
            if (loop.selectionFiber === selectedFiber) loop.selectionFiber = undefined
          }),
        ),
      ),
    )
    loop.selectionFiber = selectedFiber
    loop.fibers.add(selectedFiber)
    return selectedFiber
  }
  requestSelectionResync = (threadId) => {
    if (loop.model.currentThreadId !== threadId && loop.requestedThreadId !== threadId) return
    const key = `${threadId}:${loop.threadView?.revision ?? "missing"}`
    if (loop.selectionResyncs.has(key)) return
    loop.selectionResyncs.add(key)
    startSelection(() =>
      session.selectThread(threadId).pipe(Effect.ensuring(Effect.sync(() => loop.selectionResyncs.delete(key)))),
    )
  }
  const loadChangedFiles = readChangedFilesEffect(loop.model.workspace).pipe(
    Effect.tap((files) =>
      Effect.sync(() => {
        const current = loop.model
        loop.model = update(current, { _tag: "ChangedFilesReplaced", files })
        if (loop.model !== current) loop.renderer?.surface.update(loop.model)
      }),
    ),
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning(`changed-files load failed: ${Cause.pretty(cause)}`)),
  )
  const watchChangedFiles = FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      refreshChangedFilesOn(
        fileSystem.watch(loop.model.workspace),
        () => loop.model.changedFilesOpen,
        loadChangedFiles,
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning(`changed-files watcher stopped: ${Cause.pretty(cause)}`)),
  )
  const editComposer = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        if (options.editor === undefined) {
          loop.renderer?.surface.showToast("Set VISUAL or EDITOR to edit the prompt", "#e06c75")
          return
        }
        const relative = `${workspaceDirectory}/compose-${now}.md`
        const file = `${loop.model.workspace}/${relative}`
        yield* mkdir(`${loop.model.workspace}/.rika`, { recursive: true })
        yield* fileSystem.writeFileString(file, displayInput(loop.model))
        const resumeTerminal = pauseTerminal()
        yield* childExit("run editor", [options.editor, file], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          detached: false,
        }).pipe(Effect.ensuring(Effect.sync(resumeTerminal)))
        const edited = yield* fileSystem.readFileString(file)
        yield* rm(file, { force: true })
        loop.model = update(loop.model, { _tag: "ComposerReplaced", text: edited.replace(/\n$/, "") })
        loop.renderer?.surface.update(loop.model)
      }),
    ),
    Effect.asVoid,
    Effect.mapError((cause) =>
      ProductOperation.OperationUnavailable.make({ operation: "Edit composer", message: String(cause) }),
    ),
  )
  const openPath = (target: PathTarget) => {
    if (loop.openingPath) return
    loop.openingPath = true
    run(
      resolveLocalFileImpl(loop.model.workspace, target).pipe(
        Effect.matchEffect({
          onFailure: (failure) =>
            Effect.sync(() => {
              loop.renderer?.surface.showToast(failure.message, "#e06c75")
            }),
          onSuccess: (path) =>
            Effect.gen(function* () {
              if (options.editor === undefined) {
                const exit = yield* childExit("open file", defaultOpenArguments(path, process.platform), {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }).pipe(Effect.orElseSucceed(() => -1))
                if (exit === 0) return
                loop.renderer?.surface.showToast("Could not open the file in the default application", "#e06c75")
                return
              }
              const resumeTerminal = pauseTerminal()
              const exit = yield* childExit(
                "open editor",
                editorArguments(options.editor, path, target.line, target.column),
                {
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
                  detached: false,
                },
              ).pipe(
                Effect.orElseSucceed(() => -1),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (resumeTerminal() && !loop.closed) loop.renderer?.surface.update(loop.model)
                  }),
                ),
              )
              if (exit !== 0)
                loop.renderer?.surface.showToast("Could not open the file in the configured editor", "#e06c75")
            }),
        }),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            loop.openingPath = false
          }),
        ),
      ),
    )
  }
  const adapter: Adapter = {
    submit,
    quit: () => close(),
    editQueued: (id, prompt) => run(session.editQueued(id, prompt)),
    dequeue: (id) => run(session.dequeue(id)),
    steerQueued: (id, prompt) => run(session.steerQueued(id, prompt)),
    steer: (prompt, turnId) => run(session.steer(prompt, turnId)),
    approveAuthorization: (turnId, authorizationId) => run(session.approveAuthorization(turnId, authorizationId)),
    denyAuthorization: (turnId, authorizationId) => run(session.denyAuthorization(turnId, authorizationId)),
    interruptAndSend: (prompt) => run(session.interruptAndSend(prompt)),
    cancel: () => run(session.cancel),
    selectThread: (id) => {
      loop.requestedThreadId = id
      startSelection(() => session.selectThread(id))
    },
  }
  const consumePendingAction = () => {
    const action = loop.model.pendingAction as Action | undefined
    const command = paletteCommand(action)
    if (command?._tag === "NewThread") startSelection(() => session.newThread)
    else if (action !== undefined) {
      execute(adapter, action)
    }
    loop.model = update(loop.model, { _tag: "PaletteActionConsumed" })
  }

  return {
    pauseTerminal,
    teardown,
    close,
    interrupt,
    suspend,
    run,
    requestNewerPage,
    loadSelected,
    startSelection,
    loadChangedFiles,
    watchChangedFiles,
    editComposer,
    openPath,
    adapter,
    consumePendingAction,
    requestSelectionResync,
  }
}
