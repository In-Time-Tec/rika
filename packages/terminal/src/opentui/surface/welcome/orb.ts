import { Function } from "effect"
export interface OrbImpulse {
  readonly column: number
  readonly row: number
  readonly startPhase: number
}

export interface OrbGeometry {
  readonly columns: number
  readonly rows: number
}

const glyphRamp = ["●", "•", ":", "·", "."] as const

export type OrbGlyph = (typeof glyphRamp)[number] | " "

const rampGlyph = (intensity: number): OrbGlyph => {
  if (intensity >= 0.78) return "●"
  if (intensity >= 0.55) return "•"
  if (intensity >= 0.38) return ":"
  if (intensity >= 0.22) return "·"
  if (intensity >= 0.08) return "."
  return " "
}

const cellAspect = 0.5

const impulseDecay = 1.2
const impulseSpeed = 1.6
const impulseWidth = 0.03
const impulseGain = 1.4
const impulseLifetime = 3.2

const copyColumnWidth = 24
const orbFrameCount = 120
const orbFrameCacheLimit = 4

const orbGeometryImpl = (width: number, height: number): OrbGeometry => {
  const available = Math.max(12, Math.floor(width / 2) - 2)
  const columns = Math.max(18, Math.min(56, available))
  const rows = Math.max(9, Math.min(Math.max(9, height - spacingReserve), Math.round(columns * cellAspect)))
  return { columns, rows }
}

const spacingReserve = 8

export const orbCopyColumn = copyColumnWidth

export const orbGeometry: {
  (
    arg1: Parameters<typeof orbGeometryImpl>[1],
  ): (arg0: Parameters<typeof orbGeometryImpl>[0]) => ReturnType<typeof orbGeometryImpl>
  (
    arg0: Parameters<typeof orbGeometryImpl>[0],
    arg1: Parameters<typeof orbGeometryImpl>[1],
  ): ReturnType<typeof orbGeometryImpl>
} = Function.dual(2, orbGeometryImpl)

const orbImpulseExpiredImpl = (impulse: OrbImpulse, phase: number): boolean =>
  (phase - impulse.startPhase) * 0.09 > impulseLifetime

export const orbImpulseExpired: {
  (
    arg1: Parameters<typeof orbImpulseExpiredImpl>[1],
  ): (arg0: Parameters<typeof orbImpulseExpiredImpl>[0]) => ReturnType<typeof orbImpulseExpiredImpl>
  (
    arg0: Parameters<typeof orbImpulseExpiredImpl>[0],
    arg1: Parameters<typeof orbImpulseExpiredImpl>[1],
  ): ReturnType<typeof orbImpulseExpiredImpl>
} = Function.dual(2, orbImpulseExpiredImpl)

const surfaceIntensity = (nx: number, ny: number, nz: number, phase: number): number => {
  const angle = ((phase % orbFrameCount) / orbFrameCount) * Math.PI * 2
  const lambert = Math.max(0, nx * -0.5 + ny * -0.58 + nz * 0.65)
  const shimmer = 0.5 + 0.5 * Math.sin(nx * 3.4 + ny * 2.6 - angle * 3)
  const ripple = 0.5 + 0.5 * Math.sin(nx * 7.1 - ny * 5.2 + angle * 2)
  return lambert * 0.92 + shimmer * 0.18 + ripple * 0.08 - (nx * nx + ny * ny) * 0.18
}

const orbCell = (
  geometry: OrbGeometry,
  column: number,
  row: number,
  phase: number,
  impulses: ReadonlyArray<OrbImpulse>,
): OrbGlyph => {
  const centerColumn = (geometry.columns - 1) / 2
  const centerRow = (geometry.rows - 1) / 2
  const radius = Math.min(centerColumn, centerRow / cellAspect)
  const nx = (column - centerColumn) / radius
  const ny = (row - centerRow) / (radius * cellAspect)
  const squared = nx * nx + ny * ny
  if (squared > 1) return " "
  const nz = Math.sqrt(Math.max(0, 1 - squared))
  let intensity = Math.max(0.08, surfaceIntensity(nx, ny, nz, phase))
  for (const impulse of impulses) {
    const age = (phase - impulse.startPhase) * 0.09
    if (age < 0) continue
    const ix = (impulse.column - centerColumn) / radius
    const iy = (impulse.row - centerRow) / (radius * cellAspect)
    const dx = nx - ix
    const dy = ny - iy
    const distance = Math.sqrt(dx * dx + dy * dy)
    const front = distance - age * impulseSpeed
    intensity += Math.exp(-(front * front) / impulseWidth) * impulseGain * Math.exp(-age * impulseDecay)
  }
  return rampGlyph(intensity)
}

const renderOrbRows = (
  geometry: OrbGeometry,
  phase: number,
  impulses: ReadonlyArray<OrbImpulse>,
): ReadonlyArray<string> =>
  Array.from({ length: geometry.rows }, (_unusedRow, row) =>
    Array.from({ length: geometry.columns }, (_unusedColumn, column) =>
      orbCell(geometry, column, row, phase, impulses),
    ).join(""),
  )

const precomputedFrames = new Map<string, ReadonlyArray<ReadonlyArray<string>>>()
const framesFor = (geometry: OrbGeometry): ReadonlyArray<ReadonlyArray<string>> => {
  const key = `${geometry.columns}:${geometry.rows}`
  const cached = precomputedFrames.get(key)
  if (cached !== undefined) return cached
  const frames = Array.from({ length: orbFrameCount }, (_, phase) => renderOrbRows(geometry, phase, []))
  if (precomputedFrames.size >= orbFrameCacheLimit) {
    const oldest = precomputedFrames.keys().next().value
    if (oldest !== undefined) precomputedFrames.delete(oldest)
  }
  precomputedFrames.set(key, frames)
  return frames
}

const orbRowsImpl = (
  geometry: OrbGeometry,
  phase: number,
  impulses: ReadonlyArray<OrbImpulse>,
): ReadonlyArray<string> =>
  impulses.length === 0
    ? framesFor(geometry)[((phase % orbFrameCount) + orbFrameCount) % orbFrameCount]!
    : renderOrbRows(geometry, phase, impulses)

export const orbRows: {
  (
    arg1: Parameters<typeof orbRowsImpl>[1],
    arg2: Parameters<typeof orbRowsImpl>[2],
  ): (arg0: Parameters<typeof orbRowsImpl>[0]) => ReturnType<typeof orbRowsImpl>
  (
    arg0: Parameters<typeof orbRowsImpl>[0],
    arg1: Parameters<typeof orbRowsImpl>[1],
    arg2: Parameters<typeof orbRowsImpl>[2],
  ): ReturnType<typeof orbRowsImpl>
} = Function.dual(3, orbRowsImpl)
