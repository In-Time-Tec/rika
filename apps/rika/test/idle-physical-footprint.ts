const mebibytesByUnit: Readonly<Record<string, number>> = {
  B: 1 / 1_048_576,
  KB: 1 / 1_024,
  MB: 1,
  GB: 1_024,
  K: 1 / 1_024,
  M: 1,
  G: 1_024,
}

export const parsePhysicalFootprintMebibytes = (output: string): number | undefined => {
  for (const label of ["phys_footprint", "Physical footprint", "Footprint"]) {
    const match = output.match(new RegExp(`(?:^|\\s)${label}:\\s*([0-9.]+)\\s*(B|KB|MB|GB|K|M|G)\\b`, "i"))
    const multiplier = match?.[2] === undefined ? undefined : mebibytesByUnit[match[2].toUpperCase()]
    if (match?.[1] !== undefined && multiplier !== undefined) return Number(match[1]) * multiplier
  }
  return undefined
}
