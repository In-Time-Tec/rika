import {
  type MouseEvent,
  decodePasteBytes,
  stripAnsiSequences,
  type KeyEvent,
  type PasteEvent,
  type ColorInput,
} from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { SidebarController } from "./opentui-sidebar-controller"
import { Clock, Effect } from "effect"
import { classifyMouseJunk, fromOpenTui, type Key } from "../../presentation/terminal/terminal-keymap"
import { pastedTextTokenAt } from "../../state/model/terminal-composer-paste"
import { SurfaceTranscriptScroll } from "./opentui-transcript-scroll"

const readRendererProperty = (renderer: object, property: string): unknown => Reflect.get(renderer, property)

const isWriteFunction = (value: unknown): value is NodeJS.WriteStream["write"] => typeof value === "function"

const isDimensionStream = (value: unknown): value is Pick<NodeJS.WriteStream, "columns" | "rows"> => {
  if (typeof value !== "object" || value === null) return false
  return typeof Reflect.get(value, "columns") === "number" && typeof Reflect.get(value, "rows") === "number"
}

type RendererOutput = {
  readonly stdout: NodeJS.WriteStream
  readonly realStdoutWrite: NodeJS.WriteStream["write"]
}

const isWritableStream = (value: unknown): value is NodeJS.WriteStream =>
  typeof value === "object" && value !== null && isWriteFunction(Reflect.get(value, "write"))

const readRendererOutput = (renderer: object): RendererOutput | undefined => {
  const stdout = readRendererProperty(renderer, "stdout")
  const realStdoutWrite = readRendererProperty(renderer, "realStdoutWrite")
  if (!isWritableStream(stdout) || !isWriteFunction(realStdoutWrite)) return undefined
  return { stdout, realStdoutWrite }
}

export abstract class SurfacePointer extends SurfaceTranscriptScroll {
  protected abstract sidebarController: SidebarController
  protected abstract refreshSidebarRows(model: Model): void
  protected abstract showToast(message: string, color?: ColorInput): void
  protected readonly onKey = (key: KeyEvent) => {
    const mapped = fromOpenTui(key)
    if (this.suppressMouseJunk(mapped)) return
    if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "pageup") {
      this.cancelWheelReport()
      this.dispatchTranscriptViewport({ _tag: "DetachCommanded", anchor: this.captureViewportAnchor() })
      const amount = Math.max(1, this.transcriptScroll.viewport.height - 1)
      if (this.queuePendingTranscriptScroll(-amount)) return
      if (this.transcriptScroll.scrollTop <= 1 && this.shiftTranscriptWindow(-100, true, -amount)) return
      this.applyTranscriptPosition(this.transcriptScroll.scrollTop - amount)
      if (this.transcriptScroll.scrollTop <= 1) {
        this.syncTranscriptScrollbar()
        this.handlers.scroll?.(0)
      } else this.reportTranscriptScroll()
    } else if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "pagedown") {
      this.cancelWheelReport()
      const amount = Math.max(1, this.transcriptScroll.viewport.height - 1)
      if (this.queuePendingTranscriptScroll(amount, true)) return
      if (this.atMountedTranscriptBottom() && this.shiftTranscriptWindow(100, true, amount, true)) return
      this.applyTranscriptPosition(this.transcriptScroll.scrollTop + amount)
      this.reportTranscriptScroll(true)
    } else if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "end") {
      this.cancelWheelReport()
      this.dispatchTranscriptViewport({ _tag: "FollowCommanded" })
    } else if (mapped.ctrl && mapped.name === "v" && this.handlers.pasteImage !== undefined) this.handlers.pasteImage()
    else this.handlers.key(mapped)
  }
  protected readonly flushJunkBuffer = () => {
    this.cancelTimer(this.junkTimer)
    this.junkTimer = undefined
    const pending = this.junkBuffer
    this.junkBuffer = []
    for (const buffered of pending) this.handlers.key(buffered)
  }
  protected readonly armJunkBuffer = (mapped: Key) => {
    this.cancelTimer(this.junkTimer)
    this.junkBuffer = [mapped]
    this.junkTimer = this.delayed(40, this.flushJunkBuffer)
  }
  protected readonly suppressMouseJunk = (mapped: Key): boolean => {
    const decision = classifyMouseJunk(mapped, this.junkBuffer.length)
    switch (decision._tag) {
      case "Forward":
        return false
      case "Buffer":
        this.junkBuffer.push(mapped)
        this.cancelTimer(this.junkTimer)
        this.junkTimer = this.delayed(40, this.flushJunkBuffer)
        return true
      case "Arm":
        this.armJunkBuffer(mapped)
        return true
      case "Flush":
        this.flushJunkBuffer()
        return false
      case "Drop":
        if (this.junkBuffer.length > 0) {
          this.cancelTimer(this.junkTimer)
          this.junkTimer = undefined
          this.junkBuffer = []
        }
        return true
    }
    return false
  }
  protected readonly onPaste = (event: PasteEvent) => {
    const mediaType = event.metadata?.mimeType?.toLowerCase()
    if (event.metadata?.kind === "binary" || mediaType?.startsWith("image/") === true) {
      if (event.bytes.length > 0) {
        this.handlers.pasteImage?.(mediaType === undefined ? { bytes: event.bytes } : { bytes: event.bytes, mediaType })
      }
      return
    }
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    if (text.length === 0) return
    const now = Effect.runSync(Clock.currentTimeMillis)
    const attachment = this.model?.pastedText.findLast(
      (candidate) => candidate.type === "text" && candidate.value === text,
    )
    if (this.lastPaste?.text === text && now - this.lastPaste.at < 500 && attachment !== undefined) {
      this.handlers.expandPaste?.(attachment.token)
      this.lastPaste = undefined
      return
    }
    this.lastPaste = { text, at: now }
    this.handlers.paste?.(text)
  }
  protected readonly physicalTerminalSize = (width: number, height: number) => {
    if (readRendererProperty(this.renderer, "_usesProcessStdout") !== true) return { width, height }
    const stream = readRendererProperty(this.renderer, "stdout")
    const output = isDimensionStream(stream) ? stream : undefined
    const physicalWidth = output?.columns
    const physicalHeight = output?.rows
    const currentWidth =
      Number.isInteger(physicalWidth) && physicalWidth !== undefined && physicalWidth > 0 ? physicalWidth : width
    const currentHeight =
      Number.isInteger(physicalHeight) && physicalHeight !== undefined && physicalHeight > 0 ? physicalHeight : height
    return { width: currentWidth, height: currentHeight }
  }
  protected readonly onResize = (width: number, height: number) => {
    const current = this.physicalTerminalSize(width, height)
    if (
      (current.width !== width || current.height !== height) &&
      (this.renderer.terminalWidth !== current.width || this.renderer.terminalHeight !== current.height)
    )
      this.renderer.resize(current.width, current.height)
    this.handlers.resize(current.width, current.height)
  }
  protected readonly setPointerShape = (shape: "ns-resize" | "ew-resize" | "default") => {
    if (!this.pointerController.changeShape(shape)) return
    const renderer = readRendererOutput(this.renderer)
    if (renderer !== undefined) {
      renderer.realStdoutWrite.call(renderer.stdout, `\u001b]22;${shape}\u001b\\`)
      return
    }
    this.renderer.setMousePointer(shape === "default" ? "default" : "move")
  }
  protected readonly setComposerResizePointer = (active: boolean) => {
    this.setPointerShape(active ? "ns-resize" : "default")
  }
  protected readonly setSidebarResizePointer = (active: boolean) => {
    this.setPointerShape(active ? "ew-resize" : "default")
  }
  protected readonly onSidebarMouseMove = (event: MouseEvent) => {
    if (this.pointerController.sidebarDrag === undefined)
      this.setSidebarResizePointer(event.x === this.changedFilesBox.x)
  }
  protected readonly onSidebarMouseOut = () => {
    if (this.pointerController.sidebarDrag === undefined) this.setSidebarResizePointer(false)
  }
  protected readonly onSidebarMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || this.model === undefined) return
    if (event.x !== this.changedFilesBox.x) return
    this.pointerController.sidebarDrag = { startX: event.x, startWidth: this.model.sidebarWidth }
    this.setSidebarResizePointer(true)
    event.preventDefault()
    event.stopPropagation()
  }
  protected readonly onRootMouseDrag = (event: MouseEvent) => {
    if (this.pointerController.sidebarDrag !== undefined) {
      this.handlers.sidebarResize?.(
        this.pointerController.sidebarDrag.startWidth + (this.pointerController.sidebarDrag.startX - event.x),
      )
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.onComposerMouseDrag(event)
  }
  protected readonly onRootMouseUp = (event: MouseEvent) => {
    if (this.pointerController.sidebarDrag !== undefined) {
      this.pointerController.sidebarDrag = undefined
      this.sidebarController.invalidateWidth()
      if (this.model !== undefined) this.refreshSidebarRows(this.model)
      this.setSidebarResizePointer(event.x === this.changedFilesBox.x)
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.onComposerMouseUp(event)
  }
  protected readonly onComposerMouseMove = (event: MouseEvent) => {
    this.setComposerResizePointer(this.model?.shortcutsOpen !== true && event.y === this.inputBox.y)
  }
  protected readonly onComposerMouseOut = () => {
    if (this.pointerController.composerDrag === undefined) this.setComposerResizePointer(false)
  }
  protected readonly onComposerMouseDown = (event: MouseEvent) => {
    const model = this.model
    if (event.button !== 0 || model === undefined || model.shortcutsOpen) return
    if (model.contextDetailsOpen) {
      this.handlers.contextToggle?.()
      event.stopPropagation()
    }
    if (event.y !== this.inputBox.y) {
      const row = event.y - this.composerEditor.y
      const column = event.x - this.composerEditor.x
      const token = pastedTextTokenAt(model, row * Math.max(1, this.composerEditor.width) + column)
      if (token !== undefined) this.handlers.expandPaste?.(token)
      return
    }
    this.pointerController.composerDrag = { startY: event.y, startHeight: this.inputBox.height }
    this.setComposerResizePointer(true)
    event.preventDefault()
    event.stopPropagation()
  }
  protected readonly onComposerMouseDrag = (event: MouseEvent) => {
    if (this.pointerController.composerDrag === undefined) return
    this.handlers.composerResize?.(
      this.pointerController.composerDrag.startHeight - (event.y - this.pointerController.composerDrag.startY),
    )
    event.preventDefault()
    event.stopPropagation()
  }
  protected readonly onComposerMouseUp = (event: MouseEvent) => {
    if (this.pointerController.composerDrag === undefined) return
    this.pointerController.composerDrag = undefined
    this.setComposerResizePointer(event.y === this.inputBox.y)
    event.preventDefault()
    event.stopPropagation()
  }
  protected readonly onSelection = (selection: { getSelectedText: () => string }) => {
    const text = selection.getSelectedText().trimEnd()
    if (text.length === 0) return
    this.renderer.copyToClipboardOSC52(text)
    this.showToast("Selection copied to clipboard")
  }
}
