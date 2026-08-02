import { bold, fg, StyledText, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import { formatTokens } from "./terminal-format"
import { formatContextTokens } from "../../state/model/terminal-usage-state"
import { activeTimeAt, activeTimeIcon, formatActiveTime } from "../../state/model/terminal-activity-time"
import type { Model } from "../../state/model/terminal-state"
import * as ContextMeter from "../../state/model/terminal-context-meter"
import { colors } from "./terminal-theme"

const toneColor = (tone: ContextMeter.Tone) => {
  if (tone === "critical") return colors.red
  if (tone === "warning") return colors.amber
  return colors.teal
}
const cost = (model: Model): string => {
  if (model.usageCost?._tag === "Available") return `$${model.usageCost.usd.toFixed(2)}`
  if (model.costUsd !== undefined) return `$${model.costUsd.toFixed(2)}`
  return model.usageCost?._tag === "Loading" ? "$···" : "$—"
}
const time = (model: Model, now: number): string =>
  model.usageTime?._tag === "Available" ? formatActiveTime(activeTimeAt(model.usageTime, now)) : `${activeTimeIcon} —`

const contextDetailsImpl = (model: Model, width: number, height: number, now: number): StyledText => {
  const chunks: Array<TextChunk> = []
  const line = (text: string, color = colors.text) => {
    if (chunks.length > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(color)(text.slice(0, Math.max(1, width))))
  }
  const context = model.contextUsage
  if (context?._tag === "Available" && width <= 20) {
    const meter = ContextMeter.animatedGlyphs(context, { cells: 12, tick: model.animationTick })
    line(`${meter.join("")} ${ContextMeter.meter(context, { cells: 12 }).percent}%`)
    line(`Used       ${formatContextTokens(context.inputTokens)}`)
    line(`Available  ${formatContextTokens(Math.max(0, ContextMeter.usableTokens(context) - context.inputTokens))}`)
    line("")
    line(`Usable     ${formatContextTokens(ContextMeter.usableTokens(context))}`)
    line(`Full       ${formatContextTokens(context.contextWindow)}`)
    line("")
    line(`Cost       ${cost(model)}`)
    line(`Active     ${time(model, now)}`)
  } else if (context?._tag === "Available") {
    const cells = Math.max(4, Math.min(24, width - 7))
    const value = ContextMeter.meter(context, { cells })
    const streaming = model.busy || model.activity?._tag === "Streaming"
    const glyphs =
      streaming || model.contextAnimation.compactFromPercent !== undefined || model.contextAnimation.flashTicks > 0
        ? ContextMeter.animatedGlyphs(context, {
            cells,
            tick: model.contextAnimation.compactTick ?? model.animationTick,
            streaming,
            ...(model.contextAnimation.compactFromPercent === undefined
              ? {}
              : { compactFromPercent: model.contextAnimation.compactFromPercent }),
            ...(model.contextAnimation.flashTicks > 0 ? { flashTicks: model.contextAnimation.flashTicks } : {}),
          })
        : value.glyphs
    const tone = toneColor(value.tone)
    chunks.push(fg(tone)(glyphs.join("")), bold(fg(tone)(` ${value.percent}%`)))
    line(
      `${formatContextTokens(context.inputTokens)} used · ${formatContextTokens(Math.max(0, ContextMeter.usableTokens(context) - context.inputTokens))} available`,
    )
    if (height >= 11) {
      const divider = (label: string) => `├─ ${label} ${"─".repeat(Math.max(0, width - label.length - 5))}┤`
      line("")
      line(divider("Window"), colors.muted)
      line("")
      line(
        `${formatContextTokens(ContextMeter.usableTokens(context))} usable · ${formatContextTokens(context.contextWindow)} window · ${formatContextTokens(context.reserveTokens)} reserved`,
        colors.muted,
      )
      line("")
      line(divider("Session"), colors.muted)
      line("")
    } else if (height >= 4)
      line(
        `${formatContextTokens(ContextMeter.usableTokens(context))} usable · ${formatContextTokens(context.contextWindow)} window · ${formatContextTokens(context.reserveTokens)} reserved`,
        colors.muted,
      )
  } else {
    chunks.push(fg(colors.muted)(context?._tag === "Loading" ? "········ —" : "░░░░░░░░ —"))
    line(context?._tag === "Loading" ? "Waiting for model usage" : "Context unavailable", colors.muted)
  }
  if (width > 20 && height >= 3) line(`Cost ${cost(model)} · Active ${time(model, now)}`, colors.muted)
  if (width > 20 && height >= 4) {
    const tokens = model.usageTokens?._tag === "Available" ? formatTokens(model.usageTokens.total) : "—"
    line(`Tokens ${tokens}`, colors.muted)
  }
  return new StyledText(chunks)
}

export const contextDetails: {
  (model: Model, width: number, height: number, now: number): StyledText
  (width: number, height: number, now: number): (model: Model) => StyledText
} = Function.dual(4, contextDetailsImpl)
