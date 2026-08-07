import * as ContextMeter from "../../state/model/terminal-context-meter"
import { StyledText, fg, bold, type TextChunk } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { contentColumnWidth } from "../../state/model/terminal-layout-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { activeTimeAt, activeTimeIcon, formatActiveTime } from "../../state/model/terminal-activity-time"
import { formatTokens } from "../../presentation/terminal/terminal-format"
import { meterGlyphs } from "../../state/model/terminal-context-meter-glyph"
import { formatCost, modeLabelWidth } from "./opentui-surface-content"
import { SurfaceChrome } from "./opentui-surface-chrome"

export abstract class SurfaceModeLabel extends SurfaceChrome {
  protected renderModeLabel(model: Model): void {
    const previousRight = this.modeLabel.screenX + this.modeLabel.width
    const availableWidth = contentColumnWidth(model)
    const contextVisible = availableWidth >= 24 && (model.currentThreadId !== undefined || model.modePicker.open)
    const contextCells = availableWidth < 40 ? 4 : 8
    const contextPrefix = availableWidth < 40 ? " " : " ctx "
    const border = toOpenColor(colors.text)
    const compactUsageText = (): string => {
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
        const usageText = compactUsageText()
        if (usageText.length === 0) return []
        const usage = fg(model.currentThreadId === undefined ? border : colors[model.mode])(` ${usageText} `)
        return [this.hoverController.usageHovered ? bold(usage) : usage]
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
      chunks.push(this.hoverController.modeHovered ? bold(modeText) : modeText)
      chunks.push(fg(border)(" "))
      return chunks
    }
    const initialUsage = buildUsageChunks()
    this.hoverController.measure(initialUsage.reduce((total, chunk) => total + modeLabelWidth(chunk.text), 0))
    let modeChunks = buildModeChunks()
    let width = modeChunks.reduce((total, chunk) => total + modeLabelWidth(chunk.text), 0)
    if (this.hoverController.pointerX !== undefined && this.modeLabel.width > 0) {
      const screenX = previousRight - width
      const hovered =
        this.hoverController.pointerX >= screenX &&
        this.hoverController.pointerX < screenX + this.hoverController.usageWidth
      if (hovered !== this.hoverController.usageHovered) {
        this.hoverController.usageHovered = hovered
        this.renderer.setMousePointer(hovered ? "pointer" : "default")
        modeChunks = buildModeChunks()
        width = modeChunks.reduce((total, chunk) => total + modeLabelWidth(chunk.text), 0)
      }
    }
    this.modeLabel.width = width
    this.modeLabel.content = new StyledText(modeChunks)
    this.refreshUsageHoverAfterLayout()
  }
}
