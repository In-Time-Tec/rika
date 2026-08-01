import * as InteractiveSession from "@rika/product/interactive-session"
import { create as createTui } from "@rika/terminal/opentui-surface"
import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
import { Mode } from "@rika/terminal/terminal-state"
import { expandPastedText, execute, promptParts, type Action, type Adapter } from "@rika/terminal/terminal-session"
import { canSubmit, selectedThreadMetadata, update } from "@rika/terminal/terminal-state-reducer"
import { Effect, Fiber } from "effect"
import { imagePasteBlockedNotice } from "../input/prompt-input"
import { nextSubmissionId } from "../controller/terminal-turn-submission"
import { pasteClipboardPng, pastedImagePath, persistPastedImage } from "./process-workspace"

const nextMode = (mode: Mode): Mode => {
  const modes = Mode.literals
  return modes[(modes.indexOf(mode) + 1) % modes.length]!
}

const nextUsageDisplay = (display: "cost" | "tokens" | "time" | undefined): "cost" | "tokens" | "time" => {
  if (display === "cost") return "tokens"
  if (display === "tokens") return "time"
  return "cost"
}

type InputContext = {
  readonly loop: any
  readonly session: InteractiveSession.InteractiveSession
  readonly run: (effect: Effect.Effect<void, any, any>) => void
  readonly fork: (effect: Effect.Effect<any, any, never>) => Fiber.Fiber<any, any>
  readonly requestNewerPage: () => void
  readonly close: () => void
  readonly refreshTerminalTitle: () => void
  readonly openPath: (target: PathTarget) => void
  readonly editComposer: () => Effect.Effect<void, any, any>
  readonly recoverSession: <R>(effect: Effect.Effect<void, any, R>) => Effect.Effect<void, never, R>
  readonly render: (immediate?: boolean) => void
  readonly consumePendingAction: () => void
  readonly loadChangedFiles: () => Effect.Effect<void, any, any>
  readonly adapter: Adapter
}

export const createInputHandlers = (context: InputContext): Partial<Parameters<typeof createTui>[0]> => {
  const {
    loop,
    session,
    run,
    fork,
    requestNewerPage,
    close,
    refreshTerminalTitle,
    openPath,
    editComposer,
    recoverSession,
    render,
    consumePendingAction,
    loadChangedFiles,
    adapter,
  } = context
  return {
    workingFrame: (frame) => {
      if (loop.workingFrame === frame) return
      loop.workingFrame = frame
      refreshTerminalTitle()
    },
    openPath,
    scroll: (offset) => {
      loop.model = update(loop.model, { _tag: "ScrollMoved", offset })
      if (offset <= 0 && !loop.loadingOlder) {
        const threadId = loop.model.currentThreadId
        const before = loop.transcriptOldestCursor
        if (!loop.transcriptHasOlder || threadId === undefined || before === undefined) return
        loop.loadingOlder = true
        run(
          session
            .loadOlder(
              threadId,
              loop.activeSelectionEpoch,
              before,
              loop.loadedTranscriptEntries.map((entry: { readonly unit: { readonly key: string } }) => entry.unit.key),
            )
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  loop.loadingOlder = false
                }),
              ),
            ),
        )
      }
      if (offset > 0 && !loop.loadingOlder) requestNewerPage()
    },
    scrollGeometry: (offset) => {
      loop.model = update(loop.model, { _tag: "ScrollMoved", offset })
    },
    scrollFollow: () => {
      loop.model = update(loop.model, { _tag: "ScrollFollowed" })
      requestNewerPage()
    },
    paste: (text) => {
      loop.model = update(loop.model, { _tag: "Pasted", text })
      loop.renderer?.surface.update(loop.model)
    },
    expandPaste: (token) => {
      loop.model = update(loop.model, { _tag: "PastedTextExpanded", token })
      loop.renderer?.surface.update(loop.model)
    },
    pasteImage: (image) => {
      const blocked = imagePasteBlockedNotice(loop.model)
      if (blocked !== undefined) {
        loop.renderer?.surface.showToast(blocked)
        return
      }
      if (image !== undefined) {
        const path = pastedImagePath(image.bytes, image.mediaType)
        if (path === undefined) {
          loop.renderer?.surface.showToast("Pasted image must be a non-empty PNG, JPEG, GIF, or WebP")
          return
        }
        loop.model = update(loop.model, { _tag: "ImageInserted", path })
        loop.renderer?.surface.update(loop.model)
        run(
          persistPastedImage(loop.model.workspace, path, image.bytes).pipe(
            Effect.tap((persisted) =>
              Effect.sync(() => {
                if (persisted) return
                loop.model = update(loop.model, { _tag: "ImageRemoved", path })
                loop.renderer?.surface.update(loop.model)
                loop.renderer?.surface.showToast("Pasted image could not be saved")
              }),
            ),
            Effect.asVoid,
          ),
        )
        return
      }
      run(
        pasteClipboardPng(loop.model.workspace, undefined, undefined).pipe(
          Effect.tap((path) =>
            Effect.sync(() => {
              if (path === undefined) {
                loop.renderer?.surface.showToast("Clipboard does not contain a supported non-empty PNG image")
                return
              }
              loop.model = update(loop.model, { _tag: "ImageInserted", path })
              loop.renderer?.surface.update(loop.model)
            }),
          ),
          Effect.asVoid,
        ),
      )
    },
    clickToggle: (unit) => {
      loop.model = update(loop.model, { _tag: "DetailToggled", id: unit ?? undefined })
      loop.renderer?.surface.update(loop.model)
    },
    usageToggle: () => {
      loop.model = {
        ...loop.model,
        usageDisplay: nextUsageDisplay(loop.model.usageDisplay),
      }
      render()
    },
    modeToggle: () => {
      if (loop.model.busy) return
      loop.model = { ...loop.model, mode: nextMode(loop.model.mode) }
      render()
    },
    key: (key) => {
      if (key.ctrl && key.name === "c" && !loop.model.busy) {
        close()
        return
      }
      if (key.ctrl && key.name === "g") {
        run(editComposer())
        return
      }
      const wasChangedFilesOpen = loop.model.changedFilesOpen
      const beforePreviewId = loop.model.threadSwitcher.open ? selectedThreadMetadata(loop.model)?.id : undefined
      const submitting = key.name === "return" && !key.shift && !key.ctrl && canSubmit(loop.model)
      const submission = submitting ? nextSubmissionId(loop.submissionSequence) : undefined
      if (submission !== undefined) loop.submissionSequence = submission.sequence
      const submissionId = submission?.id
      const prompt = submitting ? loop.model.input : undefined
      const parts = prompt === undefined ? undefined : promptParts(prompt, loop.model.pastedText)
      const submittedPrompt = prompt === undefined ? undefined : expandPastedText(prompt, loop.model.pastedText)
      loop.model = update(loop.model, { _tag: "KeyPressed", key })
      if (submitting)
        loop.model = update(loop.model, {
          _tag: "Submitted",
          ...(submissionId === undefined ? {} : { submissionId }),
        })
      if (!wasChangedFilesOpen && loop.model.changedFilesOpen)
        loop.model = update(loop.model, { _tag: "ChangedFilesRequested" })
      const afterPreviewId = loop.model.threadSwitcher.open ? selectedThreadMetadata(loop.model)?.id : undefined
      if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId)
        loop.model = update(loop.model, { _tag: "ThreadPreviewRequested" })
      loop.renderer?.surface.update(loop.model)
      if (!wasChangedFilesOpen && loop.model.changedFilesOpen) run(loadChangedFiles())
      if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
        if (loop.previewTimer !== undefined) fork(Fiber.interrupt(loop.previewTimer))
        const selectedPreviewTimer = Effect.sleep("120 millis").pipe(
          Effect.andThen(session.previewThread(afterPreviewId)),
          Effect.ensuring(
            Effect.sync(() => {
              if (loop.previewTimer === selectedPreviewTimer) loop.previewTimer = undefined
            }),
          ),
          recoverSession,
          fork,
        )
        loop.previewTimer = selectedPreviewTimer
      }
      if (submittedPrompt !== undefined && submittedPrompt.length > 0 && parts !== undefined) {
        loop.submittedSinceIdle = true
        execute(adapter, {
          _tag: "Submit",
          prompt: submittedPrompt,
          parts,
          mode: loop.model.mode,
          tuning: { fastMode: loop.model.fastMode },
          ...(submissionId === undefined ? {} : { submissionId }),
        })
      }
      if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
        loop.submittedSinceIdle = false
      const action = loop.model.pendingAction as Action | undefined
      if (action !== undefined) consumePendingAction()
    },
    resize: (width, height) => {
      loop.model = update(loop.model, { _tag: "Resized", width, height })
      loop.renderer?.surface.update(loop.model)
    },
    composerResize: (height) => {
      loop.model = update(loop.model, { _tag: "ComposerHeightChanged", height })
      loop.renderer?.surface.update(loop.model)
    },
    sidebarResize: (width) => {
      loop.model = update(loop.model, { _tag: "SidebarWidthChanged", width })
      loop.renderer?.surface.update(loop.model)
    },
    threadSidebarSelect: (index) => {
      loop.model = update(loop.model, { _tag: "ThreadSidebarSelectionConfirmed", index })
      loop.renderer?.surface.update(loop.model)
      const action = loop.model.pendingAction as Action | undefined
      if (action !== undefined) consumePendingAction()
    },
    threadPreviewScroll: (offset) => {
      loop.model = update(loop.model, { _tag: "ThreadPreviewScrolled", offset })
      loop.renderer?.surface.update(loop.model)
    },
  }
}
