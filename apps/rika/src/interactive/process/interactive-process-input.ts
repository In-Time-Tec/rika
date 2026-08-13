import { create as createTui } from "@rika/terminal/opentui-surface"
import { expandPastedText, execute, promptParts, type Action } from "@rika/terminal/terminal-session"
import { canSubmit, selectedThreadMetadata, update } from "@rika/terminal/terminal-state-reducer"
import { Effect } from "effect"
import type { InteractiveInputContext } from "./interactive-runtime-context"
import { imagePasteBlockedNotice } from "../input/prompt-input"
import { nextSubmissionId } from "../controller/terminal-turn-submission"
import { pasteClipboardPng, pastedImagePath, persistPastedImage } from "./process-workspace"

type InputContext = Omit<InteractiveInputContext, "options" | "resume">

export const createInputHandlers = (context: InputContext): Partial<Parameters<typeof createTui>[0]> => {
  let quitConfirmationVisible = false
  let previewRequestId = 0
  const {
    loop,
    session,
    run,
    nextSteeringRequestId,
    previewTimer,
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
    },
    scrollGeometry: (offset) => {
      loop.model = update(loop.model, { _tag: "ScrollMoved", offset })
    },
    scrollFollow: () => {
      loop.model = update(loop.model, { _tag: "ScrollFollowed" })
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
    contextToggle: () => {
      loop.model = update(loop.model, { _tag: "ContextDetailsToggled" })
      render()
    },
    modeToggle: () => {
      loop.model = update(loop.model, { _tag: "ModeSelectorOpened" })
      render()
    },
    modeCommit: (selected) => {
      loop.model = update(loop.model, { _tag: "ModeCommitted", selected })
      render()
    },
    modeHover: (selected) => {
      loop.model = update(loop.model, { _tag: "ModeHovered", selected })
      render()
    },
    animationTick: () => {
      loop.model = update(loop.model, { _tag: "AnimationTicked" })
      render()
    },
    key: (key) => {
      if (key.ctrl && key.name === "c" && !loop.model.busy) {
        if (quitConfirmationVisible) {
          close()
          return
        }
        quitConfirmationVisible = true
        loop.renderer?.surface.showQuitConfirmation(true)
        return
      }
      if (quitConfirmationVisible) {
        if (key.name === "escape") {
          quitConfirmationVisible = false
          loop.renderer?.surface.showQuitConfirmation(false)
        }
        return
      }
      if (key.ctrl && key.name === "g") {
        run(editComposer)
        return
      }
      const wasChangedFilesOpen = loop.model.changedFilesOpen
      const beforePreviewId = loop.model.threadSwitcher.open ? selectedThreadMetadata(loop.model)?.id : undefined
      const submitting =
        key.name === "return" &&
        !key.shift &&
        !key.ctrl &&
        !loop.model.threadLoading &&
        (canSubmit(loop.model) || loop.model.contextDetailsOpen)
      if (key.name === "return" && !key.shift && !key.ctrl && loop.model.threadLoading)
        loop.renderer?.surface.showToast("Thread is still loading; your draft is preserved")
      const submission = submitting ? nextSubmissionId(loop.submissionSequence) : undefined
      if (submission !== undefined) loop.submissionSequence = submission.sequence
      const submissionId = submission?.id
      const prompt = submitting ? loop.model.input : undefined
      const parts = prompt === undefined ? undefined : promptParts(prompt, loop.model.pastedText)
      const submittedPrompt = prompt === undefined ? undefined : expandPastedText(prompt, loop.model.pastedText)
      const steeringRequestId =
        (key.ctrl && key.name === "s" && loop.model.busy && loop.model.input.length > 0) ||
        (key.name === "return" &&
          loop.model.activeTurnId !== undefined &&
          loop.model.input.length === 0 &&
          loop.model.queueSelection !== undefined)
          ? nextSteeringRequestId()
          : undefined
      loop.model = update(loop.model, {
        _tag: "KeyPressed",
        key,
        ...(steeringRequestId === undefined ? {} : { steeringRequestId }),
      })
      if (submitting)
        loop.model = update(loop.model, {
          _tag: "Submitted",
          ...(submissionId === undefined ? {} : { submissionId }),
        })
      if (!wasChangedFilesOpen && loop.model.changedFilesOpen)
        loop.model = update(loop.model, { _tag: "ChangedFilesRequested" })
      const afterPreviewId = loop.model.threadSwitcher.open ? selectedThreadMetadata(loop.model)?.id : undefined
      if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
        previewRequestId += 1
        loop.model = update(loop.model, {
          _tag: "ThreadPreviewRequested",
          threadId: afterPreviewId,
          requestId: previewRequestId,
        })
      }
      loop.renderer?.surface.update(loop.model)
      if (!wasChangedFilesOpen && loop.model.changedFilesOpen) run(loadChangedFiles)
      if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
        const requestId = previewRequestId
        previewTimer(
          Effect.sleep("120 millis").pipe(
            Effect.andThen(session.previewThread(afterPreviewId, requestId)),
            recoverSession,
          ),
        )
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
  }
}
