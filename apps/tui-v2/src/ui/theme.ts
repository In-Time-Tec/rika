import { RGBA, type ColorInput } from "@opentui/core"
import type { Mode } from "../client/model"

/**
 * The v2 surface intentionally uses the terminal's indexed palette instead of
 * introducing a second RGB theme.  The default background is left untouched
 * so Rika remains legible in light and dark terminal profiles.
 */
export const colors = {
  text: RGBA.fromIndex(7),
  muted: RGBA.fromIndex(8),
  subtle: RGBA.fromIndex(8),
  surface: RGBA.defaultBackground(),
  teal: RGBA.fromIndex(6),
  green: RGBA.fromIndex(2),
  red: RGBA.fromIndex(1),
  amber: RGBA.fromIndex(3),
  blue: RGBA.fromIndex(4),
  purple: RGBA.fromIndex(5),
  addedBg: RGBA.fromValues(20, 56, 32),
  removedBg: RGBA.fromValues(72, 28, 32),
  selectionBg: RGBA.fromIndex(3),
  selectionFg: RGBA.fromIndex(0),
  gold: RGBA.fromIndex(3),
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
