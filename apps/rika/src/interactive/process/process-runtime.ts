import * as BunServices from "@effect/platform-bun/BunServices"
import * as ProcessFiles from "./process-files"
import * as ProcessLifecycle from "./process-lifecycle"
import * as ProcessPrompt from "./process-prompt"
import * as ProcessWorkspace from "./process-workspace"
import * as ProcessLayer from "./process-layer"
import * as ProcessSignals from "./process-signals"
import { paletteCommand } from "../controller/interactive-palette-controller"
import { classifyPrompt, displayInput, promptParts } from "@rika/terminal/terminal-session"
import { execute, type Action, type Adapter, type ModelTuning } from "@rika/terminal/terminal-session"
import { update } from "@rika/terminal/terminal-state-reducer"
import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
import type { Model, Mode } from "@rika/terminal/terminal-state"
type PromptPart = ReturnType<ReturnType<typeof promptParts>>[number]
import * as Thread from "@rika/product/thread-record"
import * as ProductOperation from "@rika/product/product-operation"
import { Cause, Clock, Deferred, Effect, Fiber, FileSystem, Schema, SubscriptionRef } from "effect"
import * as Logging from "../../diagnostics/diagnostic-file-logging"
import { workspaceDirectory } from "@rika/configuration/configuration-paths"
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
  const teardown = (showGoodbye: boolean) =>
    Effect.suspend(() => {
      if (Effect.runSync(SubscriptionRef.get(loop.lifecycle))._tag === "TornDown") return Effect.void
      Effect.runSync(SubscriptionRef.set(loop.lifecycle, { _tag: "TornDown" }))
      return Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Effect.logInfo("tui.teardown.started")
          loop.closed = true
          Logging.settleActiveLogs()
          loop.renderer?.releaseTerminal()
          if (loop.initialization !== undefined) yield* Fiber.await(loop.initialization)
          if (showGoodbye) ProcessSignals.writeGoodbye(loop.model)
          yield* Effect.logInfo("tui.teardown.completed")
        }),
      )
    })
  const close = (exitCode?: number, showGoodbye = true) => {
    const current = Effect.runSync(SubscriptionRef.get(loop.lifecycle))
    if (current._tag === "Quitting" || current._tag === "TornDown") return
    Effect.runSync(SubscriptionRef.set(loop.lifecycle, { _tag: "Quitting", lastInterruptAt: undefined }))
    if (exitCode !== undefined) process.exitCode = exitCode
    fork(
      Effect.raceFirst(
        session.quit.pipe(
          Effect.catch((failure) =>
            Effect.logWarning("tui.quit.stop_work.failed").pipe(
              Effect.annotateLogs("rika.failure.kind", failure instanceof Error ? failure.name : "unknown"),
            ),
          ),
        ),
        Deferred.await(loop.forceQuit).pipe(Effect.andThen(Effect.logInfo("tui.quit.forced"))),
      ).pipe(
        Effect.timeoutOrElse({
          duration: quitStopWorkBound,
          orElse: () => Effect.logWarning("tui.quit.stop_work.timeout"),
        }),
        Effect.andThen(teardown(showGoodbye)),
        Effect.andThen(Effect.sync(() => resume(Effect.void))),
      ),
    )
  }
  const interrupt = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const lifecycle = yield* SubscriptionRef.get(loop.lifecycle)
    const decision = ProcessSignals.interruptDecision({
      lifecycle,
      hasActiveWork:
        loop.submittedSinceIdle ||
        loop.model.busy ||
        loop.model.activeTurnId !== undefined ||
        loop.model.activity !== undefined,
      now,
    })
    if (decision._tag === "Ignore") return
    if (decision._tag === "Cancel") {
      yield* SubscriptionRef.set(loop.lifecycle, { _tag: "Cancelling" })
      run(session.cancel)
      return
    }
    if (decision._tag === "ForceQuit") {
      Deferred.doneUnsafe(loop.forceQuit, Effect.void)
      return
    }
    if (lifecycle._tag === "Running" || lifecycle._tag === "Cancelling")
      loop.renderer?.surface.showToast("Quitting… press ctrl+c again to force quit")
    yield* SubscriptionRef.set(loop.lifecycle, { _tag: "Quitting", lastInterruptAt: now })
    close(tuiSignalExitCode("SIGINT"))
  })
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
  fork(ProcessSignals.watchLifecycleSignals({ interrupt, terminate, hangup, suspend, continueFromSuspend }))
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
                  loop.model = update(restored, {
                    _tag: "ExecutionFailed",
                    failure: {
                      tag: "RecoveredTurnFailed",
                      category: "operation",
                      message: failure.message,
                      retryable: false,
                      retry: "none",
                      actor: "environment",
                    },
                  })
                  loop.renderer?.surface.update(loop.model)
                }),
            ),
          )
    fork(effect.pipe(provideLayerScoped(BunServices.layer), recoverSession))
  }
  const run = <E>(effect: Effect.Effect<void, E, BunServices.BunServices>) => {
    fork(
      effect.pipe(
        provideLayerScoped(BunServices.layer),
        Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))),
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
            if (loop.selectionFiber === selectedFiber) loop.selectionFiber = undefined
          }),
        ),
      ),
    )
    loop.selectionFiber = selectedFiber
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
