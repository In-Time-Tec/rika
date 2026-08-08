export const hash = (value: string): string => {
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d]
  return seeds
    .map((seed) => {
      let result = seed >>> 0
      for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index)
        result = Math.imul(result, 0x01000193) >>> 0
      }
      return result.toString(16).padStart(8, "0")
    })
    .join("")
}

export const scopedId = (family: string, ...parts: ReadonlyArray<string | number>): string =>
  `${family}-${hash(parts.join("\u0000"))}`
