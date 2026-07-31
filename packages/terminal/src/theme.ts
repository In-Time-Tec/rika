import { RGBA } from "@opentui/core"

export const colors = {
  text: RGBA.fromIndex(7),
  subtle: RGBA.fromIndex(8),
  muted: RGBA.fromIndex(8),
  surface: RGBA.defaultBackground(),
  teal: RGBA.fromIndex(6),
  green: RGBA.fromIndex(2),
  red: RGBA.fromIndex(1),
  amber: RGBA.fromIndex(3),
  blue: RGBA.fromIndex(4),
  purple: RGBA.fromIndex(5),
  gold: RGBA.fromIndex(3),
  low: "#ffd700",
  medium: "#3dffa6",
  high: "#3dd4ff",
  ultra: "#d8b3ff",
  selectionBg: RGBA.fromIndex(3),
  selectionFg: RGBA.fromIndex(0),
  selectionHint: RGBA.fromIndex(4),
} as const

export const spacing = {
  transcript: 1,
  inputHorizontal: 1,
  inputHeight: 5,
  overlayTop: 4,
  overlayHeight: 10,
} as const
