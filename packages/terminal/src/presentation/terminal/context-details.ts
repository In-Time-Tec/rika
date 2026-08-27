import { bold, dim, fg, StyledText, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import { formatContextTokens } from "../../state/usage"
import { activeTimeAt, activeTimeIcon, formatActiveTime } from "../../state/activity/time"
import type { Model } from "../../state/model"
import * as ContextMeter from "../../state/context/meter"
import { meterGlyphs } from "../../state/context/glyph"
import { colors, modeColor } from "./theme"
import { truncateToWidth } from "./format"

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
  const selectedContext = ContextMeter.reading(context, model.modeRoutes[model.mode]?.main)
  const usable = selectedContext === undefined ? undefined : ContextMeter.usableTokens(selectedContext)
  const placeholder = context?._tag === "Loading" ? "····" : "—"
  const usageUnavailable = context?._tag === "Unavailable"
  let emptyReason: string | undefined
  if (context?._tag === "NotStarted") emptyReason = "No usage recorded yet"
  else if (context?._tag === "Unavailable") emptyReason = "Context usage is not reported by this model"
  const used =
    selectedContext === undefined || usageUnavailable ? placeholder : formatContextTokens(selectedContext.inputTokens)
  const available =
    selectedContext === undefined || usageUnavailable
      ? placeholder
      : formatContextTokens(Math.max(0, usable! - selectedContext.inputTokens))
  const full = selectedContext === undefined ? placeholder : formatContextTokens(selectedContext.contextWindow)
  const usableText = usable === undefined ? placeholder : formatContextTokens(usable)
  const cells = Math.max(4, Math.min(width < 40 ? 12 : 20, width - 5))
  const meter = selectedContext === undefined ? undefined : ContextMeter.meter(selectedContext, { cells })

  if (!compact) line("")
  if (meter === undefined)
    line(
      (model.busy
        ? ContextMeter.loadingMeter(model.animationTick, { cells })
        : Array(cells).fill(meterGlyphs.track)
      ).join(""),
      (value) => fg(modeColor(model.mode))(value),
    )
  else if (selectedContext !== undefined) {
    const baseAnimation = {
      cells,
      tick: model.contextAnimation.compactTick ?? model.contextAnimation.munchTick,
      muncher: true,
      flashTicks: model.contextAnimation.flashTicks,
    }
    const animation: ContextMeter.AnimatedMeterOptions =
      model.contextAnimation.compactFromPercent === undefined
        ? baseAnimation
        : { ...baseAnimation, compactFromPercent: model.contextAnimation.compactFromPercent }
    const glyphs = ContextMeter.animatedGlyphs(selectedContext, animation)
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
