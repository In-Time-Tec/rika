export const meterGlyphs = {
  fill: "━",
  track: "╌",
  muncherOpen: "ᗧ",
  muncherClosed: "ᗤ",
  vacuum: "≪",
  flash: "✦",
  scanner: "━",
  pellet: "·",
} as const

export const muncherGlyphs = { open: meterGlyphs.muncherOpen, closed: meterGlyphs.muncherClosed }
