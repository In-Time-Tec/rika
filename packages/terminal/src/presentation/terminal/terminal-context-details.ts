import { bold, dim, fg, StyledText, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import { formatContextTokens } from "../../state/model/terminal-usage-state"
import { activeTimeAt, activeTimeIcon, formatActiveTime } from "../../state/model/terminal-activity-time"
import type { Model } from "../../state/model/terminal-state"
import * as ContextMeter from "../../state/model/terminal-context-meter"
import { meterGlyphs } from "../../state/model/terminal-context-meter-glyph"
import { colors } from "./terminal-theme"
import { truncateToWidth } from "./terminal-format"

const cost = (model: Model): string => {
  if (model.usageCost?._tag === "Available") return `$${model.usageCost.usd.toFixed(2)}`
  if (model.costUsd !== undefined) return `$${model.costUsd.toFixed(2)}`
  return "Unknown"
}
const time = (model: Model, now: number): string =>
  model.usageTime?._tag === "Available" ? formatActiveTime(activeTimeAt(model.usageTime, now)) : `${activeTimeIcon} —`

const contextDetailsImpl = (model: Model, width: number, height: number, now: number): StyledText => {
  const chunks: Array<TextChunk> = []
  const line = (text = "", style: (value: string) => TextChunk = fg(colors.text)) => {
    if (chunks.length > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(style(truncateToWidth(text, width)))
  }
  const compact = width < 40 || height < 11
  const context = model.contextUsage
  const availableContext = context?._tag === "Available" ? context : undefined
  const usable = availableContext === undefined ? undefined : ContextMeter.usableTokens(availableContext)
  const used = availableContext === undefined ? "Unknown" : formatContextTokens(availableContext.inputTokens)
  const available =
    availableContext === undefined
      ? "Unknown"
      : formatContextTokens(Math.max(0, usable! - availableContext.inputTokens))
  const full = availableContext === undefined ? "Unknown" : formatContextTokens(availableContext.contextWindow)
  const usableText = usable === undefined ? "Unknown" : formatContextTokens(usable)
  const cells = Math.max(4, Math.min(width < 40 ? 12 : 20, width - 5))
  const meter = availableContext === undefined ? undefined : ContextMeter.meter(availableContext, { cells })
  const divider = (label: string) => `├─ ${label} ${"─".repeat(Math.max(0, width - label.length - 5))}┤`

  if (!compact) line("")
  if (meter === undefined) line(meterGlyphs.track.repeat(cells), (value) => fg(colors[model.mode])(value))
  else if (availableContext !== undefined) {
    const streaming = model.busy && model.activity?._tag !== "Compacting"
    const glyphs =
      streaming || model.contextAnimation.compactFromPercent !== undefined || model.contextAnimation.flashTicks > 0
        ? ContextMeter.animatedGlyphs(availableContext, {
            cells,
            tick: model.contextAnimation.compactTick ?? model.animationTick,
            streaming,
            ...(model.contextAnimation.compactFromPercent === undefined
              ? {}
              : { compactFromPercent: model.contextAnimation.compactFromPercent }),
            ...(model.contextAnimation.flashTicks > 0 ? { flashTicks: model.contextAnimation.flashTicks } : {}),
          })
        : meter.glyphs
    if (chunks.length > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(colors[model.mode])(glyphs.join("")), bold(fg(colors[model.mode])(` ${meter.percent}%`)))
  }
  if (!compact) line("")
  line(compact ? `Used       ${used}` : `Used        ${used}`)
  line(compact ? `Available  ${available}` : `Available   ${available}`)
  if (!compact) line("")
  line(compact ? divider("Window") : " ".repeat(width), (value) => dim(fg(colors.text)(value)))
  if (!compact) line("")
  line(`Usable     ${usableText}`)
  line(`Full       ${full}`)
  if (!compact) line("")
  line(compact ? divider("Session") : " ".repeat(width), (value) => dim(fg(colors.text)(value)))
  if (!compact) line("")
  line(`Cost       ${cost(model)}`)
  line(`Active     ${time(model, now)}`)
  if (!compact) line("")
  return new StyledText(chunks)
}

export const contextDetails: {
  (model: Model, width: number, height: number, now: number): StyledText
  (width: number, height: number, now: number): (model: Model) => StyledText
} = Function.dual(4, contextDetailsImpl)
