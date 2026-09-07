import { RGBA, type ColorInput } from "@opentui/core"
import type { Mode } from "../client/model"

export const colors = {
  text: RGBA.fromHex("#c6c8c6"),
  muted: RGBA.fromHex("#666666"),
  subtle: RGBA.fromHex("#666666"),
  surface: RGBA.fromHex("#282c34"),
  teal: RGBA.fromHex("#8abeb7"),
  green: RGBA.fromHex("#b5bd68"),
  red: RGBA.fromHex("#cc6666"),
  amber: RGBA.fromHex("#f0c674"),
  blue: RGBA.fromHex("#81a2be"),
  purple: RGBA.fromHex("#b294bb"),
  addedBg: RGBA.fromValues(20, 56, 32),
  removedBg: RGBA.fromValues(72, 28, 32),
  selectionBg: RGBA.fromHex("#f0c674"),
  selectionFg: RGBA.fromHex("#1d1f21"),
  gold: RGBA.fromHex("#f0c674"),
  runner: "#d2a25c",
  orb: "#ae77ff",
} as const satisfies Record<string, ColorInput>

export const modeColors = {
  low: "#ffd700",
  medium: "#3dffa6",
  high: "#3dd4ff",
  ultra: "#d8b3ff",
} as const

export const modeColor = (mode: Mode): string => modeColors[mode]

export const activityColors = {
  idle: colors.muted,
  working: colors.teal,
  waiting: colors.amber,
  cancelled: colors.amber,
  failed: colors.red,
} as const

export const spacing = {
  transcript: 1,
  inputHorizontal: 1,
  inputHeight: 5,
  overlayTop: 3,
} as const
