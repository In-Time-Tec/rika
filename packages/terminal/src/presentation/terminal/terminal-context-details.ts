import { bold, dim, fg, StyledText, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import { formatContextTokens } from "../../state/model/terminal-usage-state"
import { activeTimeAt, activeTimeIcon, formatActiveTime } from "../../state/model/terminal-activity-time"
import type { Model } from "../../state/model/terminal-state"
import * as ContextMeter from "../../state/model/terminal-context-meter"
import { meterGlyphs } from "../../state/model/terminal-context-meter-glyph"
import { colors, modeColor } from "./terminal-theme"
import { truncateToWidth } from "./terminal-format"

const cost = (model: Model): string => {
  if (model.usageCost?._tag === "Included") return "Included in subscription"
  if (model.usageCost?._tag === "Available") return `$${model.usageCost.usd.toFixed(2)}`
  if (model.usageCost?._tag === "Loading" || model.busy) return "····"
  return "—"
}
const time = (model: Model, now: number): string =>
  model.usageTime?._tag === "Available" ? formatActiveTime(activeTimeAt(model.usageTime, now)) : `${activeTimeIcon} —`
const cached = (model: Model): string => {
  const context = model.contextUsage
  if (context?._tag !== "Available" || context.inputTotal === 0) return "—"
  return `${Math.round((context.inputCacheRead / context.inputTotal) * 100)}%`
}

const contextDetailsImpl = (model: Model, width: number, height: number, now: number): StyledText => {
  const chunks: Array<TextChunk> = []
  const line = (text = "", style: (value: string) => TextChunk = fg(colors.text)) => {
    if (chunks.length > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(style(truncateToWidth(text, width)))
  }
  const compact = width < 40 || height < 16
  const context = model.contextUsage
  const availableContext = context?._tag === "Available" ? context : undefined
  const usable = availableContext === undefined ? undefined : ContextMeter.usableTokens(availableContext)
  const placeholder = context?._tag === "Loading" ? "····" : "—"
  let emptyReason: string | undefined
  if (context?._tag === "NotStarted") emptyReason = "No usage yet — send a message to see context usage"
  else if (context?._tag === "Unavailable") emptyReason = "Context usage is not reported by this model"
  const used = availableContext === undefined ? placeholder : formatContextTokens(availableContext.inputTokens)
  const available =
    availableContext === undefined
      ? placeholder
      : formatContextTokens(Math.max(0, usable! - availableContext.inputTokens))
  const full = availableContext === undefined ? placeholder : formatContextTokens(availableContext.contextWindow)
  const usableText = usable === undefined ? placeholder : formatContextTokens(usable)
  const cells = Math.max(4, Math.min(width < 40 ? 12 : 20, width - 5))
  const meter = availableContext === undefined ? undefined : ContextMeter.meter(availableContext, { cells })

  if (!compact) line("")
  if (meter === undefined)
    line(
      (model.busy
        ? ContextMeter.loadingMeter(model.animationTick, { cells })
        : Array(cells).fill(meterGlyphs.track)
      ).join(""),
      (value) => fg(modeColor(model.mode))(value),
    )
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
    chunks.push(fg(modeColor(model.mode))(glyphs.join("")), bold(fg(modeColor(model.mode))(` ${meter.percent}%`)))
  }
  if (!compact) line("")
  line(compact ? `Used       ${used}` : `Used        ${used}`)
  line(compact ? `Available  ${available}` : `Available   ${available}`)
  if (!compact) line("")
  line(" ".repeat(width), (value) => dim(fg(colors.text)(value)))
  if (!compact) line("")
  line(`Usable     ${usableText}`)
  line(`Full       ${full}`)
  if (!compact) line("")
  line(" ".repeat(width), (value) => dim(fg(colors.text)(value)))
  if (!compact) line("")
  line(`Cost       ${cost(model)}`)
  line(`Cached     ${cached(model)}`)
  line(`Active     ${time(model, now)}`)
  if (!compact) line("")
  if (!compact && emptyReason !== undefined) line(emptyReason, (value) => dim(fg(colors.text)(value)))
  return new StyledText(chunks)
}

export const contextDetails: {
  (model: Model, width: number, height: number, now: number): StyledText
  (width: number, height: number, now: number): (model: Model) => StyledText
} = Function.dual(4, contextDetailsImpl)
