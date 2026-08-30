import {
  type MouseEvent,
  decodePasteBytes,
  stripAnsiSequences,
  type KeyEvent,
  type PasteEvent,
  type ColorInput,
} from "@opentui/core"
import { Option, Schema } from "effect"
import type { Model } from "../../../state/model"
import { SidebarController } from "../sidebar/controller"
import { classifyMouseJunk, fromOpenTui, type Key } from "../../../presentation/terminal/keymap"
import { pastedTextTokenAt } from "../../../state/composer/paste"
import { SurfaceState } from "../state"

const ProcessRenderer = Schema.Struct({
  _usesProcessStdout: Schema.Literal(true),
  stdout: Schema.Struct({ columns: Schema.Finite, rows: Schema.Finite }),
})

const processRenderer = Schema.decodeUnknownOption(ProcessRenderer)
const unmodified = (key: Key): boolean => !key.ctrl && !key.alt && !key.meta
const transcriptNavigationKey = (key: Key): boolean =>
  unmodified(key) && ["pageup", "pagedown", "home", "end"].includes(key.name)
const pasteImage = (event: PasteEvent): { readonly bytes: Uint8Array; readonly mediaType?: string } | undefined => {
  const mediaType = event.metadata?.mimeType?.toLowerCase()
  if (event.metadata?.kind !== "binary" && mediaType?.startsWith("image/") !== true) return undefined
  return mediaType === undefined ? { bytes: event.bytes } : { bytes: event.bytes, mediaType }
}

export abstract class SurfacePointer extends SurfaceState {
  private pointerStyle: "ns-resize" | "ew-resize" | "default" = "default"
  protected abstract sidebarController: SidebarController
  protected abstract refreshSidebarRows(model: Model): void
  protected abstract showToast(message: string, color?: ColorInput): void
  private navigate(key: Key): boolean {
    if (!transcriptNavigationKey(key)) return false
    const target = this.model?.threadSwitcher.open === true ? this.threadBrowser : this.transcriptPane
    switch (key.name) {
      case "pageup":
        target.pageUp()
        return true
      case "pagedown":
        target.pageDown()
        return true
      case "home":
        target.home()
        return true
      case "end":
        target.end()
        return true
      default:
        return false
    }
  }
  protected readonly onKey = (key: KeyEvent) => {
    const mapped = fromOpenTui(key)
    if (this.suppressMouseJunk(mapped)) return
    if (this.model?.contextDetailsOpen === true && transcriptNavigationKey(mapped)) return
    if (this.navigate(mapped)) return
    if (mapped.ctrl && mapped.name === "v" && this.handlers.pasteImage !== undefined) this.handlers.pasteImage()
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
    const image = pasteImage(event)
    if (image !== undefined) {
      if (event.bytes.length > 0) this.handlers.pasteImage?.(image)
      return
    }
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    if (text.length === 0) return
    const now = this.currentTimeMillis()
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
    const output = Option.getOrUndefined(processRenderer(this.renderer))
    if (output === undefined) return { width, height }
    const physicalWidth = output.stdout.columns
    const physicalHeight = output.stdout.rows
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
  protected readonly setPointerCursor = (style: "ns-resize" | "ew-resize" | "default") => {
    if (this.pointerStyle === style) return
    this.pointerStyle = style
    this.renderer.setMousePointer(style === "default" ? "default" : "move")
  }
  protected readonly setComposerResizePointer = (active: boolean) => {
    this.setPointerCursor(active ? "ns-resize" : "default")
  }
  protected readonly setSidebarResizePointer = (active: boolean) => {
    this.setPointerCursor(active ? "ew-resize" : "default")
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
