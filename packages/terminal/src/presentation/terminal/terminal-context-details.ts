import { bold, fg, StyledText, type TextChunk } from "@opentui/core"
import { formatContextTokens, formatTokens } from "./terminal-format"
import { activeTimeAt, activeTimeIcon, formatActiveTime } from "../../state/model/terminal-activity-time"
import type { Model } from "../../state/model/terminal-state"
import * as ContextMeter from "../../state/model/terminal-context-meter"
import { colors } from "./terminal-theme"

const toneColor = (tone: ContextMeter.Tone) => (tone === "critical" ? colors.red : tone === "warning" ? colors.amber : colors.teal)
const cost = (model: Model): string => {
  if (model.usageCost?._tag === "Available") return `$${model.usageCost.usd.toFixed(2)}`
  if (model.costUsd !== undefined) return `$${model.costUsd.toFixed(2)}`
  return model.usageCost?._tag === "Loading" ? "$···" : "$—"
}
const time = (model: Model, now: number): string =>
  model.usageTime?._tag === "Available" ? formatActiveTime(activeTimeAt(model.usageTime, now)) : `${activeTimeIcon} —`

export const contextDetails = (model: Model, width: number, height: number, now: number): StyledText => {
  const chunks: Array<TextChunk> = []
  const line = (text: string, color = colors.text) => {
    if (chunks.length > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(color)(text.slice(0, Math.max(1, width))))
  }
  const context = model.contextUsage
  if (context?._tag === "Available") {
    const value = ContextMeter.meter(context, { cells: Math.max(4, Math.min(24, width - 7)) })
    const tone = toneColor(value.tone)
    chunks.push(fg(tone)(value.glyphs.join("")), bold(fg(tone)(` ${value.percent}%`)))
    line(`${formatContextTokens(context.inputTokens)} used · ${formatContextTokens(Math.max(0, ContextMeter.usableTokens(context) - context.inputTokens))} available`)
    if (height >= 4)
      line(`${formatContextTokens(ContextMeter.usableTokens(context))} usable · ${formatContextTokens(context.contextWindow)} window · ${formatContextTokens(context.reserveTokens)} reserved`, colors.muted)
  } else {
    chunks.push(fg(colors.muted)(context?._tag === "Loading" ? "········ —" : "░░░░░░░░ —"))
    line(context?._tag === "Loading" ? "Waiting for model usage" : "Context unavailable", colors.muted)
  }
  if (height >= 3) line(`Cost ${cost(model)} · Active ${time(model, now)}`, colors.muted)
  if (height >= 4) {
    const tokens = model.usageTokens?._tag === "Available" ? formatTokens(model.usageTokens.total) : "—"
    line(`Tokens ${tokens}`, colors.muted)
  }
  return new StyledText(chunks)
}
