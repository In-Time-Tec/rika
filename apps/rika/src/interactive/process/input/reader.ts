import { create as createTui } from "@rika/terminal/opentui-surface"
import type * as BunServices from "@effect/platform-bun/BunServices"
import { expandPastedText, execute, promptParts, type Action } from "@rika/terminal/terminal-session"
import { canSubmit, selectedThreadMetadata, update } from "@rika/terminal/terminal-state-reducer"
import * as ProductOperation from "@rika/product/product-operation"
import { Effect } from "effect"
import type { InteractiveInputContext } from "../runtime/context"
import { imagePasteBlockedNotice } from "../../input/prompt"
import { nextSubmissionId } from "../../controller/turn-submission"
import { refreshThreadsOnSwitcherOpen } from "../lifecycle/contract"
import { pasteClipboardPng, pastedImagePath, persistPastedImage } from "../workspace/context"

type InputContext = Omit<InteractiveInputContext, "options" | "resume"> & {
  readonly startSelection: (
    select: () => Effect.Effect<void, ProductOperation.OperationUnavailable>,
    acceptsCreatedThread?: boolean,
  ) => void
  readonly rememberMode?: (mode: string) => Effect.Effect<void, never, BunServices.BunServices>
}

type InputKey = Parameters<NonNullable<Parameters<typeof createTui>[0]["key"]>>[0]
type SubmitParts = Extract<Action, { readonly _tag: "Submit" }>["parts"]

const isCtrlKey = (key: InputKey, name: string): boolean => key.ctrl && key.name === name

const isPlainReturn = (key: InputKey): boolean => key.name === "return" && !key.shift && !key.ctrl

const requestsSteering = (key: InputKey, model: InputContext["loop"]["model"]): boolean =>
  (isCtrlKey(key, "s") && model.busy && model.input.length > 0) ||
  (key.name === "return" &&
    model.activeTurnId !== undefined &&
    model.input.length === 0 &&
    model.queueSelection !== undefined)

const previewThreadId = (model: InputContext["loop"]["model"]): string | undefined =>
  model.threadSwitcher.open ? selectedThreadMetadata(model)?.id : undefined

const changedFilesOpened = (wasOpen: boolean, isOpen: boolean): boolean => !wasOpen && isOpen

const previewSelectionChanged = (before: string | undefined, after: string | undefined): after is string =>
  after !== undefined && after !== before

const hasSubmittedPrompt = (prompt: string | undefined): prompt is string => prompt !== undefined && prompt.length > 0

export const createInputHandlers = (context: InputContext): Parameters<typeof createTui>[0] => {
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
    startSelection,
    rememberMode,
  } = context
  const showCtrlCMenu = (visible: boolean) => {
    loop.ctrlCMenuVisible = visible
    loop.renderer?.surface.showCtrlCMenu(visible)
  }
  const rememberCommittedMode = (previous: string | undefined) => {
    const committed = loop.model.rememberedMode
    if (committed !== undefined && committed !== previous && rememberMode !== undefined) run(rememberMode(committed))
  }
  const handleCtrlC = (key: InputKey): boolean => {
    if (!isCtrlKey(key, "c")) return false
    const cancellable = loop.model.busy || loop.model.submittedDrafts.some((draft) => draft.turnId === undefined)
    if (cancellable && loop.model.cancelPending) {
      close()
      return true
    }
    if (cancellable) return false
    if (loop.ctrlCMenuVisible) {
      showCtrlCMenu(false)
      close()
      return true
    }
    showCtrlCMenu(true)
    return true
  }
  const handleCtrlCMenu = (key: InputKey): boolean => {
    if (!loop.ctrlCMenuVisible) return false
    if (key.name === "escape") {
      showCtrlCMenu(false)
      return true
    }
    if (isCtrlKey(key, "n")) {
      showCtrlCMenu(false)
      startSelection(
        () =>
          session.archiveAndNewThread.pipe(
            Effect.tapError((failure) =>
              Effect.sync(() => loop.renderer?.surface.showToast(failure.message, "#e06c75")),
            ),
          ),
        true,
      )
      return true
    }
    if (isCtrlKey(key, "e")) {
      showCtrlCMenu(false)
      run(
        session.archiveThread.pipe(
          Effect.tap(() => Effect.sync(close)),
          Effect.tapError((failure) => Effect.sync(() => loop.renderer?.surface.showToast(failure.message, "#e06c75"))),
        ),
      )
    }
    return true
  }
  const prepareSubmission = (submitting: boolean) => {
    const submission = submitting ? nextSubmissionId(loop.submissionSequence) : undefined
    if (submission !== undefined) loop.submissionSequence = submission.sequence
    const prompt = submitting ? loop.model.input : undefined
    return {
      submissionId: submission?.id,
      parts: prompt === undefined ? undefined : promptParts(prompt, loop.model.pastedText),
      submittedPrompt: prompt === undefined ? undefined : expandPastedText(prompt, loop.model.pastedText),
    }
  }
  const applyKeyTransition = (key: InputKey) => {
    const wasChangedFilesOpen = loop.model.changedFilesOpen
    const wasThreadSwitcherOpen = loop.model.threadSwitcher.open
    const beforePreviewId = previewThreadId(loop.model)
    const submitting = isPlainReturn(key) && !loop.model.threadLoading && canSubmit(loop.model)
    if (isPlainReturn(key) && loop.model.threadLoading)
      loop.renderer?.surface.showToast("Thread is still loading; your draft is preserved")
    const submission = prepareSubmission(submitting)
    const steeringRequestId = requestsSteering(key, loop.model) ? nextSteeringRequestId() : undefined
    const previousRememberedMode = loop.model.rememberedMode
    loop.model = update(
      loop.model,
      steeringRequestId === undefined ? { _tag: "KeyPressed", key } : { _tag: "KeyPressed", key, steeringRequestId },
    )
    rememberCommittedMode(previousRememberedMode)
    if (submitting)
      loop.model = update(
        loop.model,
        submission.submissionId === undefined
          ? { _tag: "Submitted" }
          : { _tag: "Submitted", submissionId: submission.submissionId },
      )
    if (changedFilesOpened(wasChangedFilesOpen, loop.model.changedFilesOpen))
      loop.model = update(loop.model, { _tag: "ChangedFilesRequested" })
    return { wasChangedFilesOpen, wasThreadSwitcherOpen, beforePreviewId, ...submission }
  }
  const requestThreadPreview = (beforePreviewId: string | undefined): string | undefined => {
    const afterPreviewId = previewThreadId(loop.model)
    const previewChanged = previewSelectionChanged(beforePreviewId, afterPreviewId)
    if (previewChanged) {
      previewRequestId += 1
      loop.model = update(loop.model, {
        _tag: "ThreadPreviewRequested",
        threadId: afterPreviewId,
        requestId: previewRequestId,
      })
    }
    return previewChanged ? afterPreviewId : undefined
  }
  const runKeyEffects = (
    wasChangedFilesOpen: boolean,
    wasThreadSwitcherOpen: boolean,
    previewId: string | undefined,
    submittedPrompt: string | undefined,
    parts: SubmitParts | undefined,
    submissionId: string | undefined,
  ) => {
    loop.renderer?.surface.update(loop.model)
    if (changedFilesOpened(wasChangedFilesOpen, loop.model.changedFilesOpen)) run(loadChangedFiles)
    run(
      refreshThreadsOnSwitcherOpen(wasThreadSwitcherOpen, loop.model.threadSwitcher.open, session.refreshThreads).pipe(
        recoverSession,
      ),
    )
    if (previewId !== undefined) {
      const requestId = previewRequestId
      previewTimer(
        Effect.sleep("120 millis").pipe(Effect.andThen(session.previewThread(previewId, requestId)), recoverSession),
      )
    }
    if (hasSubmittedPrompt(submittedPrompt) && parts !== undefined) {
      loop.submittedSinceIdle = true
      const action = {
        _tag: "Submit",
        prompt: submittedPrompt,
        parts,
        mode: loop.model.mode,
        tuning: { fastMode: loop.model.fastMode },
      } satisfies Action
      execute(adapter, submissionId === undefined ? action : { ...action, submissionId })
    }
    if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
      loop.submittedSinceIdle = false
    if (loop.model.pendingAction !== undefined) consumePendingAction()
  }
  const handleKey = (key: InputKey) => {
    const cancellable = loop.model.busy || loop.model.submittedDrafts.some((draft) => draft.turnId === undefined)
    if (handleCtrlC(key)) return
    if (cancellable && loop.ctrlCMenuVisible) showCtrlCMenu(false)
    if (handleCtrlCMenu(key)) return
    if (isCtrlKey(key, "g")) {
      run(editComposer)
      return
    }
    const transition = applyKeyTransition(key)
    const previewId = requestThreadPreview(transition.beforePreviewId)
    runKeyEffects(
      transition.wasChangedFilesOpen,
      transition.wasThreadSwitcherOpen,
      previewId,
      transition.submittedPrompt,
      transition.parts,
      transition.submissionId,
    )
  }
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
      const previous = loop.model.rememberedMode
      loop.model = update(loop.model, { _tag: "ModeCommitted", selected })
      rememberCommittedMode(previous)
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
    key: handleKey,
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
      if (loop.model.pendingAction !== undefined) consumePendingAction()
    },
  }
}
