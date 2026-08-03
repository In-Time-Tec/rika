import {
  CliRenderEvents,
  decodePasteBytes,
  stripAnsiSequences,
  bold,
  dim,
  fg,
  StyledText,
  type MouseEvent,
  type KeyEvent,
  type PasteEvent,
  type TextChunk,
} from "@opentui/core"
import { Clock, Effect, Fiber, Schedule } from "effect"
import { fromOpenTui, type Key } from "../../presentation/terminal/terminal-keymap"
import { activeTimeAt } from "../../state/model/terminal-activity-time"
import { type Model } from "../../state/model/terminal-state"
import { activeTimeIcon, formatActiveTime } from "../../state/model/terminal-activity-time"
import { formatActivity } from "../../state/model/terminal-activity-state"
import { pastedTextTokenAt } from "../../state/model/terminal-composer-paste"
import { SurfaceOverlayRegion } from "./opentui-overlay-region"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { formatTokens } from "../../presentation/terminal/terminal-format"
import * as ContextMeter from "../../state/model/terminal-context-meter"
import { meterGlyphs } from "../../state/model/terminal-context-meter-glyph"
import { loaderFrame } from "../rendering/opentui-spinner"
import { spinnerFrames } from "../rendering/opentui-spinner"
import { renderSidebar } from "../rendering/opentui-render-block"
import { panelLoading, formatCost, modeLabelWidth } from "./opentui-surface-content"
import { contentColumnWidth } from "../../state/model/terminal-layout-state"

const mouseSequencePattern = new RegExp(`^(?:${String.fromCharCode(27)}?\\[)?<?\\d+(?:;\\d+)*[Mm]?$`)

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

export abstract class SurfaceInput extends SurfaceOverlayRegion {
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

  protected cancelTimer(timer: Fiber.Fiber<void> | undefined): void {
    timer?.interruptUnsafe()
  }

  protected defer(action: () => void): void {
    Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(action))))
  }

  protected delayed(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(Effect.sleep(duration).pipe(Effect.andThen(Effect.sync(action))))
  }

  protected repeated(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(
      Effect.sleep(duration).pipe(
        Effect.andThen(Effect.sync(action)),
        Effect.repeat(Schedule.spaced(duration)),
        Effect.asVoid,
      ),
    )
  }

  protected publishWorkingFrame(frame: string | undefined): void {
    if (this.workingFramePublished && this.publishedWorkingFrame === frame) return
    this.workingFramePublished = true
    this.publishedWorkingFrame = frame
    this.handlers.workingFrame?.(frame)
  }

  protected renderModeLabel(model: Model): void {
    const previousRight = this.modeLabel.screenX + this.modeLabel.width
    const availableWidth = contentColumnWidth(model)
    const contextVisible = availableWidth >= 24 && (model.currentThreadId !== undefined || model.modePicker.open)
    const contextCells = availableWidth < 40 ? 4 : 8
    const contextPrefix = availableWidth < 40 ? " " : " ctx "
    const border = toOpenColor(colors.text)
    const legacyUsageText = (): string => {
      if (model.usageDisplay === "time") {
        if (model.usageTime?._tag === "Available")
          return formatActiveTime(activeTimeAt(model.usageTime, this.currentTimeMillis()))
        return model.usageTime?._tag === "Unavailable" ? `${activeTimeIcon} —` : `${activeTimeIcon} ····`
      }
      if (model.usageDisplay === "tokens") {
        if (model.usageTokens?._tag === "Available")
          return model.usageTokens.uncountedAttempts > 0
            ? formatTokens(model.usageTokens.total).replace(/ tok$/, "+ tok")
            : formatTokens(model.usageTokens.total)
        return model.usageTokens?._tag === "Unavailable" ? "— tok" : "···· tok"
      }
      if (model.usageCost?._tag === "Available") return formatCost(model.usageCost.usd)
      if (model.costUsd !== undefined) return formatCost(model.costUsd)
      if (model.usageCost?._tag === "Unavailable") return "$—"
      return model.usageCost?._tag === "Loading" || model.busy ? "$····" : ""
    }
    const buildUsageChunks = (): Array<TextChunk> => {
      if (!contextVisible) {
        const usageText = legacyUsageText()
        if (usageText.length === 0) return []
        const usage = fg(model.currentThreadId === undefined ? border : colors[model.mode])(` ${usageText} `)
        return [this.usageLabelHovered ? bold(usage) : usage]
      }
      const chunks: Array<TextChunk> = [fg(colors[model.mode])(contextPrefix)]
      const context = model.contextUsage
      if (context?._tag === "Available") {
        const value = ContextMeter.meter(context, { cells: contextCells })
        const streaming = model.busy && model.activity?._tag !== "Compacting"
        const glyphs =
          streaming || model.contextAnimation.compactFromPercent !== undefined || model.contextAnimation.flashTicks > 0
            ? ContextMeter.animatedGlyphs(context, {
                cells: contextCells,
                tick: model.contextAnimation.compactTick ?? model.animationTick,
                streaming,
                ...(model.contextAnimation.compactFromPercent === undefined
                  ? {}
                  : { compactFromPercent: model.contextAnimation.compactFromPercent }),
                ...(model.contextAnimation.flashTicks > 0 ? { flashTicks: model.contextAnimation.flashTicks } : {}),
              })
            : value.glyphs
        const filled = value.glyphs.filter((glyph) => glyph === meterGlyphs.fill).length
        for (const [index, glyph] of glyphs.entries()) {
          let glyphColor = colors[model.mode]
          if (model.modeCommit !== undefined && index < filled)
            glyphColor =
              index < Math.min(filled, model.modeCommit.tick)
                ? colors[model.modeCommit.to]
                : colors[model.modeCommit.from]
          chunks.push(fg(glyphColor)(glyph))
        }
        chunks.push(bold(fg(colors[model.mode])(` ${value.percent}% `)))
        return chunks
      }
      const glyphs = model.busy
        ? ContextMeter.loadingMeter(model.animationTick, { cells: contextCells })
        : Array.from({ length: contextCells }, () => meterGlyphs.track)
      for (const glyph of glyphs) chunks.push(fg(colors[model.mode])(glyph))
      chunks.push(fg(border)(" "))
      return chunks
    }
    const buildModeChunks = (): Array<TextChunk> => {
      const usageChunks = buildUsageChunks()
      const chunks = [...usageChunks]
      if (usageChunks.length > 0) chunks.push(fg(border)("─"))
      chunks.push(fg(border)(" "))
      if (model.fastMode) chunks.push(fg(toOpenColor(colors.amber))("↯"))
      const commit = model.modeCommit
      let modeLabel: string = model.mode
      let cursor = ""
      if (commit !== undefined) {
        if (commit.tick < commit.from.length) modeLabel = commit.from.slice(0, commit.from.length - commit.tick - 1)
        else {
          const typed = Math.min(commit.to.length, commit.tick - commit.from.length + 1)
          modeLabel = commit.to.slice(0, typed)
          if (typed < commit.to.length) cursor = "▮"
        }
      }
      const modeText = fg(colors[model.mode])(`${modeLabel}${cursor}`)
      chunks.push(this.modeLabelHovered ? bold(modeText) : modeText)
      chunks.push(fg(border)(" "))
      return chunks
    }
    const initialUsage = buildUsageChunks()
    this.usageLabelWidth = initialUsage.reduce((total, chunk) => total + modeLabelWidth(chunk.text), 0)
    this.modeSegmentStart = this.usageLabelWidth === 0 ? 0 : this.usageLabelWidth + 1
    let modeChunks = buildModeChunks()
    let width = modeChunks.reduce((total, chunk) => total + modeLabelWidth(chunk.text), 0)
    if (this.usagePointerX !== undefined && this.modeLabel.width > 0) {
      const screenX = previousRight - width
      const hovered = this.usagePointerX >= screenX && this.usagePointerX < screenX + this.usageLabelWidth
      if (hovered !== this.usageLabelHovered) {
        this.usageLabelHovered = hovered
        this.renderer.setMousePointer(hovered ? "pointer" : "default")
        modeChunks = buildModeChunks()
        width = modeChunks.reduce((total, chunk) => total + modeLabelWidth(chunk.text), 0)
      }
    }
    this.modeLabel.width = width
    this.modeLabel.content = new StyledText(modeChunks)
    this.refreshUsageHoverAfterLayout()
  }

  protected refreshUsageHoverAfterLayout(): void {
    if (this.usagePointerX === undefined || this.usageLayoutFrame !== undefined) return
    const refresh = () => {
      this.renderer.off(CliRenderEvents.FRAME, refresh)
      this.usageLayoutFrame = undefined
      if (this.destroyed || this.usagePointerX === undefined) return
      const hovered =
        this.usagePointerX >= this.modeLabel.screenX &&
        this.usagePointerX < this.modeLabel.screenX + this.usageLabelWidth
      if (hovered === this.usageLabelHovered) return
      this.usageLabelHovered = hovered
      this.renderer.setMousePointer(hovered ? "pointer" : "default")
      if (this.model !== undefined) this.renderModeLabel(this.model)
      this.renderer.requestRender()
    }
    this.usageLayoutFrame = refresh
    this.renderer.on(CliRenderEvents.FRAME, refresh)
  }

  protected tickLoader(): void {
    if (this.destroyed) return
    this.loaderPhase += 1
    this.handlers.animationTick?.()
    this.toolSpinner.step()
    const current = this.model
    if (current !== undefined) {
      const label = formatActivity(current.activity) ?? panelLoading(current)
      if (label !== undefined)
        this.statusLabel.content = new StyledText([
          fg(toOpenColor(colors.text))(" "),
          fg(toOpenColor(colors.blue))(loaderFrame(label, current.animationTick + this.loaderPhase)),
          dim(fg(toOpenColor(colors.text))(` ${label} `)),
        ])
      const glyph = this.toolSpinner.toBraille()
      if (current.busy) this.publishWorkingFrame(glyph)
      if (current.usageDisplay === "time" && current.usageTime?._tag === "Available") this.renderModeLabel(current)
      for (const record of this.transcriptRecords.values()) {
        if (record.spinnerChunk === undefined) continue
        const content = record.renderable.content
        const chunks = [...content.chunks]
        const chunk = chunks[record.spinnerChunk]
        if (chunk === undefined) continue
        chunks[record.spinnerChunk] = { ...chunk, text: glyph }
        record.renderable.content = new StyledText(chunks)
      }
      if (current.threadSidebar.open)
        this.sidebar.content = renderSidebar(current, spinnerFrames[this.loaderPhase % spinnerFrames.length]!)
    }
    this.renderer.requestRender()
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
    if (mapped.ctrl || mapped.alt || mapped.meta || mapped.eventType === "release") return false
    if (mapped.sequence.length > 1 && mouseSequencePattern.test(mapped.sequence)) return true
    if (this.junkBuffer.length > 0) {
      if (/^[\d;]$/.test(mapped.sequence) && this.junkBuffer.length < 24) {
        this.junkBuffer.push(mapped)
        this.cancelTimer(this.junkTimer)
        this.junkTimer = this.delayed(40, this.flushJunkBuffer)
        return true
      }
      if (mapped.sequence === "M" || mapped.sequence === "m") {
        this.cancelTimer(this.junkTimer)
        this.junkTimer = undefined
        this.junkBuffer = []
        return true
      }
      if (mapped.sequence === "<") {
        this.armJunkBuffer(mapped)
        return true
      }
      this.flushJunkBuffer()
      return false
    }
    if (mapped.sequence === "<") {
      this.armJunkBuffer(mapped)
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
    if (this.pointerShape === shape) return
    this.pointerShape = shape
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
    if (this.sidebarDrag === undefined) this.setSidebarResizePointer(event.x === this.changedFilesBox.x)
  }
  protected readonly onSidebarMouseOut = () => {
    if (this.sidebarDrag === undefined) this.setSidebarResizePointer(false)
  }
  protected readonly onSidebarMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || this.model === undefined) return
    if (event.x !== this.changedFilesBox.x) return
    this.sidebarDrag = { startX: event.x, startWidth: this.model.sidebarWidth }
    this.setSidebarResizePointer(true)
    event.preventDefault()
    event.stopPropagation()
  }
  protected readonly onRootMouseDrag = (event: MouseEvent) => {
    if (this.sidebarDrag !== undefined) {
      this.handlers.sidebarResize?.(this.sidebarDrag.startWidth + (this.sidebarDrag.startX - event.x))
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.onComposerMouseDrag(event)
  }
  protected readonly onRootMouseUp = (event: MouseEvent) => {
    if (this.sidebarDrag !== undefined) {
      this.sidebarDrag = undefined
      this.sidebarRowsWidth = 0
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
    if (this.composerDrag === undefined) this.setComposerResizePointer(false)
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
    this.composerDrag = { startY: event.y, startHeight: this.inputBox.height }
    this.setComposerResizePointer(true)
    event.preventDefault()
    event.stopPropagation()
  }
  protected readonly onComposerMouseDrag = (event: MouseEvent) => {
    if (this.composerDrag === undefined) return
    this.handlers.composerResize?.(this.composerDrag.startHeight - (event.y - this.composerDrag.startY))
    event.preventDefault()
    event.stopPropagation()
  }
  protected readonly onComposerMouseUp = (event: MouseEvent) => {
    if (this.composerDrag === undefined) return
    this.composerDrag = undefined
    this.setComposerResizePointer(event.y === this.inputBox.y)
    event.preventDefault()
    event.stopPropagation()
  }
}
