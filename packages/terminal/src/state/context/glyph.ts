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

export const glyphFallbacks = {
  muncherOpen: "C",
  muncherClosed: "c",
} as const

export const glyphCapabilities = {
  muncher: true,
} as const

export const muncherGlyphs: { readonly open: string; readonly closed: string } = glyphCapabilities.muncher
  ? { open: meterGlyphs.muncherOpen, closed: meterGlyphs.muncherClosed }
  : { open: glyphFallbacks.muncherOpen, closed: glyphFallbacks.muncherClosed }
