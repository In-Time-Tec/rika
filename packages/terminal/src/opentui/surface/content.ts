import { Function } from "effect"
import { dim, fg, bold, StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model, Mode } from "../../state/model"
import { isLoading } from "../../state/loadable"
import { activeTimeIcon } from "../../state/activity/time"
import { colors, modeColor, spacing } from "../../presentation/terminal/theme"
import { formatActivity } from "../../state/activity/model"
import { loaderFrame } from "../rendering/spinner"
import { toOpenColor } from "../rendering/text-adapter"
import { contentColumnWidth } from "../../state/layout/model"
import { homeRelativePath } from "../../presentation/terminal/format"
import { orbGeometry, orbRows, type OrbImpulse } from "./welcome/orb"
export const panelLoading = (model: Model): string | undefined => {
  if (model.currentThreadId !== undefined && model.refoldingThreadIds.includes(model.currentThreadId))
    return "Rebuilding thread projection"
  if (model.threadLoading) return "Loading Thread"
  if (model.changedFilesOpen && isLoading(model.changedFiles)) return "Loading changed files"
  if ((model.workspaceFilesOpen || model.filePicker.open) && isLoading(model.filePicker.items)) return "Loading files"
  return undefined
}

const connectivityActivity = (model: Model): string | undefined => {
  const connection = model.connection
  if (connection?.connectivity === "connecting") return "Connecting"
  if (connection?.connectivity === "reconnecting") return "Reconnecting"
  return undefined
}

const connectionActivity = (model: Model): string | undefined => {
  const connection = model.connection
  switch (connection?.activity) {
    case "authenticating":
      return "Authenticating"
    case "workspace-preparing":
      return "Preparing workspace"
    case "workspace-failed":
      return "Workspace preparation failed"
    case "approval-required":
      return "Approval required"
    case "unknown-operation":
      return "Operation status unknown"
    default:
      return undefined
  }
}

const authoritativeActivity = (model: Model): string | undefined => {
  switch (model.connection?.activity) {
    case "authenticating":
    case "workspace-preparing":
    case "workspace-failed":
    case "approval-required":
    case "unknown-operation":
      return connectionActivity(model)
    default:
      return undefined
  }
}

const lifecycleLabelImpl = (model: Model, currentTimeMillis: number): string | undefined =>
  connectivityActivity(model) ??
  authoritativeActivity(model) ??
  formatActivity(
    model.activity,
    model.activity?._tag === "Retrying"
      ? Math.max(0, Math.ceil((model.activity.nextAt - currentTimeMillis) / 1000))
      : model.retryCountdown,
  ) ??
  connectionActivity(model) ??
  panelLoading(model)

export const lifecycleLabel: {
  (currentTimeMillis: number): (model: Model) => string | undefined
  (model: Model, currentTimeMillis: number): string | undefined
} = Function.dual(2, lifecycleLabelImpl)

const statusContentImpl = (model: Model, phase: number, currentTimeMillis: number): StyledText | string => {
  const lifecycle = lifecycleLabel(model, currentTimeMillis)
  if (lifecycle === undefined) return ""
  const chunks: Array<TextChunk> = [fg(toOpenColor(colors.text))(" ")]
  chunks.push(fg(toOpenColor(colors.blue))(loaderFrame(lifecycle, phase)))
  chunks.push(dim(fg(toOpenColor(colors.text))(` ${lifecycle} `)))
  return new StyledText(chunks)
}

export const statusContent: {
  (phase: number, currentTimeMillis: number): (model: Model) => StyledText | string
  (model: Model, phase: number, currentTimeMillis: number): StyledText | string
} = Function.dual(3, statusContentImpl)

export const animationActive = (model: Model): boolean =>
  model.compactionShimmer !== undefined ||
  model.busy ||
  model.activity !== undefined ||
  connectivityActivity(model) !== undefined ||
  connectionActivity(model) !== undefined ||
  panelLoading(model) !== undefined ||
  (model.usageDisplay === "time" &&
    model.usageTime?._tag === "Available" &&
    model.usageTime.activeSince !== undefined) ||
  (model.modePicker.open && model.modePicker.turnTick !== undefined) ||
  model.modeCommit !== undefined ||
  model.contextAnimation.flashTicks > 0 ||
  model.contextAnimation.compactTick !== undefined ||
  (model.threadSidebar.open && model.threads.some((thread) => thread.status !== "idle" && thread.status !== "error"))

/**
 * Gates the goal timer's EXISTENCE. `model.goal !== undefined` would pin the timer on forever after
 * any goal is ever set; only an active goal animates.
 */
export const goalAnimationActive = (model: Model): boolean => model.goal?.status === "active"

/** The goal indicator shares the context meter's width threshold so narrow terminals stay legible. */
export const goalIndicatorVisible = (model: Model): boolean =>
  goalAnimationActive(model) && contentColumnWidth(model) >= 24

export const compactWorkspace = (workspace: string): string => {
  const home = homeRelativePath(workspace)
  const segments = home.split("/").filter((segment) => segment.length > 0)
  if (segments.length <= 5) return home
  return [segments.slice(0, 2).join("/"), "…", segments.slice(-2).join("/")].join("/")
}

export const formatCost = (usd: number): string =>
  usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(usd) < 0.01 ? 3 : 2,
  })

export const modeLabelWidth = (text: string): number => stringWidth(text.replaceAll(activeTimeIcon, "x"))

const modeShade = (mode: Mode, intensity: number): string => {
  const hex = modeColor(mode).slice(1)
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  const channel = (value: number) =>
    Math.round(value * intensity)
      .toString(16)
      .padStart(2, "0")
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

const welcomeMarkColor = (glyph: string, mode: Mode): string => {
  if (glyph === "●") return modeShade(mode, 1)
  if (glyph === "•") return modeShade(mode, 0.84)
  if (glyph === ":") return modeShade(mode, 0.68)
  if (glyph === "·") return modeShade(mode, 0.52)
  return modeShade(mode, 0.4)
}

const welcomeContentImpl = (
  width: number,
  height: number,
  phase: number,
  mode: Mode,
  impulses: ReadonlyArray<OrbImpulse> = [],
): StyledText => {
  if (height < 20)
    return new StyledText([
      fg(colors.text)("\n"),
      fg(modeColor(mode))(`${" ".repeat(Math.max(0, Math.floor((width - 15) / 2)))}Welcome to Rika`),
      fg(colors.text)("\n\n"),
      fg(colors.text)(`${" ".repeat(Math.max(0, Math.floor((width - 24) / 2)))}ctrl+o commands   ? help`),
    ])
  const geometry = orbGeometry(width, height)
  const canvas = orbRows(geometry, phase, impulses)
  const area = Math.max(1, height - spacing.inputHeight)
  const top = Math.max(0, Math.floor((area - geometry.rows) / 2))
  const center = Math.floor(width / 2)
  const logoLeft = Math.max(0, center - geometry.columns - 2)
  const copyLeft = Math.max(0, Math.min(width - 1, center + 2))
  const visibleCanvas = canvas.slice(0, Math.max(1, area - top))
  const chunks: TextChunk[] = [fg(colors.text)("\n".repeat(top))]
  const copyTop = Math.max(0, Math.floor((geometry.rows - 5) / 2))
  const copy = new Map<number, ReadonlyArray<TextChunk>>([
    [copyTop, [bold(fg(modeColor(mode))("Welcome to Rika"))]],
    [copyTop + 3, [bold(fg(colors.text)("ctrl+o")), fg(colors.muted)(" for commands")]],
    [copyTop + 4, [bold(fg(colors.text)("?")), fg(colors.muted)(" for shortcuts")]],
  ])
  for (let row = 0; row < visibleCanvas.length; row += 1) {
    if (row > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(colors.text)(" ".repeat(logoLeft)))
    const line = visibleCanvas[row] ?? ""
    for (const glyph of line) {
      if (glyph === " ") chunks.push(fg(colors.text)(glyph))
      else {
        chunks.push(fg(welcomeMarkColor(glyph, mode))(glyph))
      }
    }
    const suffix = copy.get(row)
    if (suffix !== undefined) {
      chunks.push(fg(colors.text)(" ".repeat(Math.max(1, copyLeft - logoLeft - stringWidth(line)))))
      chunks.push(...suffix)
    }
  }
  return new StyledText(chunks)
}

export const welcomeContent: {
  (
    arg1: Parameters<typeof welcomeContentImpl>[1],
    arg2: Parameters<typeof welcomeContentImpl>[2],
    arg3: Parameters<typeof welcomeContentImpl>[3],
    arg4?: Parameters<typeof welcomeContentImpl>[4],
  ): (arg0: Parameters<typeof welcomeContentImpl>[0]) => ReturnType<typeof welcomeContentImpl>
  (
    arg0: Parameters<typeof welcomeContentImpl>[0],
    arg1: Parameters<typeof welcomeContentImpl>[1],
    arg2: Parameters<typeof welcomeContentImpl>[2],
    arg3: Parameters<typeof welcomeContentImpl>[3],
    arg4?: Parameters<typeof welcomeContentImpl>[4],
  ): ReturnType<typeof welcomeContentImpl>
} = Function.dual(4, welcomeContentImpl)
