import * as BunServices from "@effect/platform-bun/BunServices"
import * as ProcessFiles from "../workspace/files"
import * as ProcessLifecycle from "../lifecycle/contract"
import * as ProcessPrompt from "../input/prompt"
import * as ProcessWorkspace from "../workspace/context"
import * as ProcessLayer from "./layer"
import * as ProcessSignals from "../lifecycle/signals"
import * as PaletteController from "../../controller/palette"
import { classifyPrompt, displayInput, promptParts } from "@rika/terminal/terminal-session"
import { execute, type Adapter, type ModelTuning } from "@rika/terminal/terminal-session"
import { update } from "@rika/terminal/terminal-state-reducer"
import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
import { Mode } from "@rika/terminal/terminal-state"
type PromptPart = ReturnType<ReturnType<typeof promptParts>>[number]
import * as Thread from "@rika/product/thread-record"
import * as ProductOperation from "@rika/product/product-operation"
import { Cause, Clock, Deferred, Effect, Fiber, FileSystem, Option, Schema, SubscriptionRef } from "effect"
import * as Logging from "../../../diagnostics/file-logging"
import { workspaceDirectory } from "@rika/configuration/configuration-paths"
import type { InteractiveRuntimeContext } from "./context"

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

const PromptPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, pasted: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("image"), path: Schema.String }),
])
const PendingAction = Schema.Union([
  Schema.TaggedStruct("Submit", {
    prompt: Schema.String,
    parts: Schema.Array(PromptPart),
    mode: Mode,
    tuning: Schema.optionalKey(Schema.Struct({ fastMode: Schema.optionalKey(Schema.Boolean) })),
    submissionId: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("EditQueued", { id: Schema.String, prompt: Schema.String }),
  Schema.TaggedStruct("Dequeue", { id: Schema.String }),
  Schema.TaggedStruct("SteerQueued", {
    id: Schema.String,
    prompt: Schema.String,
    requestId: Schema.String,
  }),
  Schema.TaggedStruct("Steer", {
    prompt: Schema.String,
    requestId: Schema.String,
    turnId: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("ApproveAuthorization", { turnId: Schema.String, authorizationId: Schema.String }),
  Schema.TaggedStruct("DenyAuthorization", { turnId: Schema.String, authorizationId: Schema.String }),
  Schema.TaggedStruct("InterruptAndSend", { prompt: Schema.String }),
  Schema.TaggedStruct("SetSubagentLimit", {
    limit: Schema.Literals(["maxDepth", "maxSubagents"]),
    value: Schema.Finite,
  }),
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("Quit", {}),
  Schema.TaggedStruct("NewThread", {}),
  Schema.TaggedStruct("NewOrbThread", {}),
  Schema.TaggedStruct("PauseOrb", {}),
  Schema.TaggedStruct("ResumeOrb", {}),
  Schema.TaggedStruct("EnableRemoteThreadCreation", {}),
  Schema.TaggedStruct("DisableRemoteThreadCreation", {}),
  Schema.TaggedStruct("SelectThread", { id: Schema.String }),
])
const decodePendingAction = Schema.decodeUnknownOption(PendingAction)

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
          loop.renderer?.releaseTerminal()
          if (loop.initialization !== undefined) yield* Fiber.await(loop.initialization)
          if (showGoodbye) ProcessSignals.writeGoodbye(loop.model)
          yield* Effect.logInfo("tui.teardown.completed")
          yield* Logging.settleActiveLogs
        }),
      )
    })
  const close = (exitCode?: number, showGoodbye = true, lastInterruptAt?: number) => {
    const current = Effect.runSync(SubscriptionRef.get(loop.lifecycle))
    if (current._tag === "Quitting" || current._tag === "TornDown") return
    Effect.runSync(SubscriptionRef.set(loop.lifecycle, { _tag: "Quitting", lastInterruptAt }))
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
    close(tuiSignalExitCode("SIGINT"), true, now)
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
          )
    fork(
      effect.pipe(
        provideLayerScoped(BunServices.layer),
        Effect.catch((failure) =>
          Effect.sync(() => {
            if (submissionId === undefined) {
              loop.renderer?.surface.showToast(failure.message, "#e06c75")
              return
            }
            loop.model = update(loop.model, {
              _tag: "SubmissionRejected",
              submissionId,
              message: failure.message,
            })
            if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
              loop.submittedSinceIdle = false
            loop.renderer?.surface.update(loop.model)
          }),
        ),
      ),
    )
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
  let adapter: Adapter = {
    submit,
    quit: () => close(),
    editQueued: (id, prompt) => run(session.editQueued(id, prompt)),
    dequeue: (id) => run(session.dequeue(id)),
    steerQueued: (id, prompt, requestId) => run(session.steerQueued(id, prompt, requestId)),
    steer: (prompt, requestId, turnId) => run(session.steer(prompt, requestId, turnId)),
    approveAuthorization: (turnId, authorizationId) => run(session.approveAuthorization(turnId, authorizationId)),
    denyAuthorization: (turnId, authorizationId) => run(session.denyAuthorization(turnId, authorizationId)),
    interruptAndSend: (prompt) => run(session.interruptAndSend(prompt)),
    cancel: () => run(session.cancel),
    newThread: () => startSelection(() => session.newThread),
    selectThread: (id) => {
      loop.requestedThreadId = id
      startSelection(() => session.selectThread(id))
    },
  }
  if (session.newOrbThread !== undefined) {
    const newOrbThread = session.newOrbThread
    adapter = { ...adapter, newOrbThread: () => startSelection(() => newOrbThread) }
  }
  if (session.pauseOrb !== undefined) {
    const pauseOrb = session.pauseOrb
    adapter = { ...adapter, pauseOrb: () => run(pauseOrb) }
  }
  if (session.resumeOrb !== undefined) {
    const resumeOrb = session.resumeOrb
    adapter = { ...adapter, resumeOrb: () => run(resumeOrb) }
  }
  if (session.enableRemoteThreadCreation !== undefined) {
    const enableRemoteThreadCreation = session.enableRemoteThreadCreation
    adapter = { ...adapter, enableRemoteThreadCreation: () => run(enableRemoteThreadCreation) }
  }
  if (session.disableRemoteThreadCreation !== undefined) {
    const disableRemoteThreadCreation = session.disableRemoteThreadCreation
    adapter = { ...adapter, disableRemoteThreadCreation: () => run(disableRemoteThreadCreation) }
  }
  const consumePendingAction = () => {
    const action = Option.getOrUndefined(decodePendingAction(loop.model.pendingAction))
    if (action?._tag === "SetSubagentLimit")
      run(
        PaletteController.writeSubagentLimit(loop.model.workspace, action.limit, action.value).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              loop.renderer?.surface.showToast(
                `${action.limit === "maxDepth" ? "Max depth" : "Max subagents"} set to ${action.value}`,
              )
            }),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              loop.renderer?.surface.showToast("Could not update workspace subagent settings", "#e06c75")
            }),
          ),
        ),
      )
    else if (action !== undefined) execute(adapter, action)
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
