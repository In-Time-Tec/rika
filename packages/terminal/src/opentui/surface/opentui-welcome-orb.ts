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

export const orbGeometry = (width: number, height: number): OrbGeometry => {
  const columns = Math.max(24, Math.min(72, width - 2))
  const rows = Math.max(9, Math.min(22, Math.floor((columns * cellAspect) / 1.6)))
  return { columns, rows }
}

export const orbImpulseExpired = (impulse: OrbImpulse, phase: number): boolean =>
  (phase - impulse.startPhase) * 0.09 > impulseLifetime

const surfaceIntensity = (nx: number, ny: number, nz: number, time: number): number => {
  const lambert = Math.max(0, nx * -0.5 + ny * -0.58 + nz * 0.65)
  const shimmer = 0.5 + 0.5 * Math.sin(nx * 3.4 + ny * 2.6 - time * 2)
  const ripple = 0.5 + 0.5 * Math.sin(nx * 7.1 - ny * 5.2 + time * 1.3)
  return lambert * 0.92 + shimmer * 0.18 + ripple * 0.08 - (nx * nx + ny * ny) * 0.18
}

export const orbCell = (
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
  const time = phase * 0.09
  let intensity = Math.max(0.08, surfaceIntensity(nx, ny, nz, time))
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

export const orbRows = (
  geometry: OrbGeometry,
  phase: number,
  impulses: ReadonlyArray<OrbImpulse>,
): ReadonlyArray<string> =>
  Array.from({ length: geometry.rows }, (_, row) =>
    Array.from({ length: geometry.columns }, (_, column) => orbCell(geometry, column, row, phase, impulses)).join(""),
  )
