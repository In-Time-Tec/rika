import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

interface ImageData {
  readonly path: string
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

interface DiffBox {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface Crop {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

interface PairDiff {
  readonly amp_index: number
  readonly rika_index: number
  readonly amp: {
    readonly path: string
    readonly sha256: string
    readonly width: number
    readonly height: number
  }
  readonly rika: {
    readonly path: string
    readonly sha256: string
    readonly width: number
    readonly height: number
  }
  readonly same_dimensions: boolean
  readonly compared_pixels: number
  readonly diff_pixel_denominator: number
  readonly different_pixels: number
  readonly different_percent: number
  readonly diff_bbox: DiffBox | null
  readonly total_absolute_channel_delta: number
  readonly mean_absolute_channel_delta: number
  readonly max_channel_delta: number
}

const args = Bun.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.error(
    "Usage: bun run scripts/parity-burst-compare.ts [--amp <png>]... [--rika <png>]... [--amp-dir <dir>] [--rika-dir <dir>] [--include <regex>] [--crop <left,top,width,height>] [--generated-at <iso>] [--out <file.json>] [--diff-image <file.png>]",
  )
  process.exit(0)
}

const includePattern = optionalArg("--include")
const include = includePattern === undefined ? undefined : new RegExp(includePattern)
const crop = parseCrop(optionalArg("--crop"))
const generatedAt = optionalArg("--generated-at")
const outPath = optionalArg("--out")
const diffImagePath = optionalArg("--diff-image")
const ampPaths = collectPaths("amp")
const rikaPaths = collectPaths("rika")

if (ampPaths.length === 0) throw new Error("No Amp screenshots supplied")
if (rikaPaths.length === 0) throw new Error("No Rika screenshots supplied")

const tempDir = mkdtempSync(join(tmpdir(), "rika-parity-burst-"))

try {
  const ampImages = ampPaths.map((path, index) => loadImage(path, join(tempDir, `amp-${index}-${basename(path)}.bmp`)))
  const rikaImages = rikaPaths.map((path, index) => loadImage(path, join(tempDir, `rika-${index}-${basename(path)}.bmp`)))
  const pairs: Array<PairDiff> = []

  ampImages.forEach((amp, ampIndex) => {
    rikaImages.forEach((rika, rikaIndex) => {
      pairs.push(compare(amp, rika, ampIndex, rikaIndex))
    })
  })

  const sortedPairs = pairs.toSorted((a, b) => a.total_absolute_channel_delta - b.total_absolute_channel_delta)
  const best = sortedPairs[0]
  if (best === undefined) throw new Error("No comparison pairs generated")

  if (diffImagePath !== undefined) {
    const amp = ampImages[best.amp_index]
    const rika = rikaImages[best.rika_index]
    if (amp === undefined || rika === undefined) throw new Error("Best pair references missing image")
    writeDiffImage(amp, rika, diffImagePath, join(tempDir, `${basename(diffImagePath)}.bmp`))
  }

  const output = {
    kind: "parity-burst-compare",
    generated_at: generatedAt ?? new Date().toISOString(),
    method: {
      source: "pairwise exact RGBA diff after sips BMP conversion",
      ranking: "ascending total_absolute_channel_delta",
      include: includePattern ?? null,
      crop,
    },
    amp_count: ampImages.length,
    rika_count: rikaImages.length,
    pair_count: pairs.length,
    best_pair: {
      ...best,
      visual_diff_image: diffImagePath ?? null,
    },
    pairs: sortedPairs,
  }
  const json = `${JSON.stringify(output, null, 2)}\n`

  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, json)
  }

  process.stdout.write(json)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

function optionalArg(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function parseCrop(value: string | undefined): Crop | null {
  if (value === undefined) return null
  const [left, top, width, height] = value.split(",").map((part) => Number(part))
  if (
    !Number.isInteger(left) ||
    !Number.isInteger(top) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    left < 0 ||
    top < 0 ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`Invalid crop ${value}`)
  }
  return { left, top, width, height }
}

function repeatedArgs(flag: string): ReadonlyArray<string> {
  const values: Array<string> = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`Missing value for ${flag}`)
      values.push(value)
    }
  }
  return values
}

function collectPaths(kind: "amp" | "rika"): ReadonlyArray<string> {
  const explicit = repeatedArgs(`--${kind}`)
  const directory = optionalArg(`--${kind}-dir`)
  const fromDirectory =
    directory === undefined
      ? []
      : readdirSync(directory)
          .filter((file) => file.endsWith(".png") && (include === undefined || include.test(file)))
          .toSorted((a, b) => a.localeCompare(b))
          .map((file) => join(directory, file))
  return [...explicit, ...fromDirectory]
}

function loadImage(path: string, bmpPath: string): ImageData {
  const converted = Bun.spawnSync(["sips", "-s", "format", "bmp", path, "--out", bmpPath], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!converted.success) {
    throw new Error(`sips failed for ${path}: ${converted.stderr.toString()}`)
  }

  const source = readFileSync(path)
  const bmp = readFileSync(bmpPath)
  const width = bmp.readInt32LE(18)
  const rawHeight = bmp.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const bitsPerPixel = bmp.readUInt16LE(28)
  const pixelOffset = bmp.readUInt32LE(10)

  if (bitsPerPixel !== 32) {
    throw new Error(`Expected 32-bit BMP for ${path}, got ${bitsPerPixel}`)
  }

  const stride = width * 4
  const pixels = new Uint8Array(width * height * 4)

  for (let row = 0; row < height; row += 1) {
    const sourceRow = rawHeight < 0 ? row : height - row - 1
    const sourceOffset = pixelOffset + sourceRow * stride
    const targetOffset = row * stride
    for (let column = 0; column < width; column += 1) {
      const sourcePixel = sourceOffset + column * 4
      const targetPixel = targetOffset + column * 4
      pixels[targetPixel] = bmp[sourcePixel + 2] ?? 0
      pixels[targetPixel + 1] = bmp[sourcePixel + 1] ?? 0
      pixels[targetPixel + 2] = bmp[sourcePixel] ?? 0
      pixels[targetPixel + 3] = bmp[sourcePixel + 3] ?? 255
    }
  }

  return {
    path,
    sha256: createHash("sha256").update(source).digest("hex"),
    width,
    height,
    pixels,
  }
}

function compare(amp: ImageData, rika: ImageData, ampIndex: number, rikaIndex: number): PairDiff {
  const sameDimensions = amp.width === rika.width && amp.height === rika.height
  const width = crop === null ? Math.min(amp.width, rika.width) : Math.min(crop.width, amp.width - crop.left, rika.width - crop.left)
  const height = crop === null ? Math.min(amp.height, rika.height) : Math.min(crop.height, amp.height - crop.top, rika.height - crop.top)
  const left = crop?.left ?? 0
  const top = crop?.top ?? 0
  const ampPixels = amp.width * amp.height
  const rikaPixels = rika.width * rika.height
  const overlapPixels = width * height
  const diffPixelDenominator = crop === null ? ampPixels + rikaPixels - overlapPixels : overlapPixels
  let differentPixels = crop === null ? ampPixels + rikaPixels - overlapPixels * 2 : 0
  let totalAbsoluteChannelDelta = 0
  let maxChannelDelta = 0
  let bbox: DiffBox | undefined

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sourceRow = top + row
      const sourceColumn = left + column
      const ampOffset = (sourceRow * amp.width + sourceColumn) * 4
      const rikaOffset = (sourceRow * rika.width + sourceColumn) * 4
      const dr = Math.abs((amp.pixels[ampOffset] ?? 0) - (rika.pixels[rikaOffset] ?? 0))
      const dg = Math.abs((amp.pixels[ampOffset + 1] ?? 0) - (rika.pixels[rikaOffset + 1] ?? 0))
      const db = Math.abs((amp.pixels[ampOffset + 2] ?? 0) - (rika.pixels[rikaOffset + 2] ?? 0))
      const da = Math.abs((amp.pixels[ampOffset + 3] ?? 0) - (rika.pixels[rikaOffset + 3] ?? 0))
      const delta = dr + dg + db + da
      totalAbsoluteChannelDelta += delta
      maxChannelDelta = Math.max(maxChannelDelta, dr, dg, db, da)

      if (delta > 0) {
        differentPixels += 1
        bbox =
          bbox === undefined
            ? { left: sourceColumn, top: sourceRow, right: sourceColumn, bottom: sourceRow }
            : {
                left: Math.min(bbox.left, sourceColumn),
                top: Math.min(bbox.top, sourceRow),
                right: Math.max(bbox.right, sourceColumn),
                bottom: Math.max(bbox.bottom, sourceRow),
              }
      }
    }
  }

  const comparedPixels = width * height
  const diffBox =
    bbox ??
    (sameDimensions
      ? null
      : {
          left: 0,
          top: 0,
          right: Math.max(amp.width, rika.width) - 1,
          bottom: Math.max(amp.height, rika.height) - 1,
        })

  return {
    amp_index: ampIndex,
    rika_index: rikaIndex,
    amp: { path: amp.path, sha256: amp.sha256, width: amp.width, height: amp.height },
    rika: { path: rika.path, sha256: rika.sha256, width: rika.width, height: rika.height },
    same_dimensions: sameDimensions,
    compared_pixels: comparedPixels,
    diff_pixel_denominator: diffPixelDenominator,
    different_pixels: differentPixels,
    different_percent: diffPixelDenominator === 0 ? 0 : (differentPixels / diffPixelDenominator) * 100,
    diff_bbox: diffBox,
    total_absolute_channel_delta: totalAbsoluteChannelDelta,
    mean_absolute_channel_delta: comparedPixels === 0 ? 0 : totalAbsoluteChannelDelta / (comparedPixels * 4),
    max_channel_delta: maxChannelDelta,
  }
}

function writeDiffImage(amp: ImageData, rika: ImageData, outputPath: string, bmpPath: string): void {
  const width = crop === null ? Math.min(amp.width, rika.width) : Math.min(crop.width, amp.width - crop.left, rika.width - crop.left)
  const height = crop === null ? Math.min(amp.height, rika.height) : Math.min(crop.height, amp.height - crop.top, rika.height - crop.top)
  const left = crop?.left ?? 0
  const top = crop?.top ?? 0
  const pixels = new Uint8Array(width * height * 4)

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sourceRow = top + row
      const sourceColumn = left + column
      const ampOffset = (sourceRow * amp.width + sourceColumn) * 4
      const rikaOffset = (sourceRow * rika.width + sourceColumn) * 4
      const targetOffset = (row * width + column) * 4
      const dr = Math.abs((amp.pixels[ampOffset] ?? 0) - (rika.pixels[rikaOffset] ?? 0))
      const dg = Math.abs((amp.pixels[ampOffset + 1] ?? 0) - (rika.pixels[rikaOffset + 1] ?? 0))
      const db = Math.abs((amp.pixels[ampOffset + 2] ?? 0) - (rika.pixels[rikaOffset + 2] ?? 0))
      const da = Math.abs((amp.pixels[ampOffset + 3] ?? 0) - (rika.pixels[rikaOffset + 3] ?? 0))
      const delta = dr + dg + db + da
      if (delta > 0) {
        pixels[targetOffset] = 255
        pixels[targetOffset + 1] = Math.min(255, delta)
        pixels[targetOffset + 2] = 96
        pixels[targetOffset + 3] = 255
      }
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeBmp(bmpPath, width, height, pixels)
  const converted = Bun.spawnSync(["sips", "-s", "format", "png", bmpPath, "--out", outputPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!converted.success) {
    throw new Error(`sips failed for diff image ${outputPath}: ${converted.stderr.toString()}`)
  }
}

function writeBmp(path: string, width: number, height: number, pixels: Uint8Array): void {
  const headerSize = 14 + 124
  const stride = width * 4
  const fileSize = headerSize + stride * height
  const bmp = Buffer.alloc(fileSize)
  bmp.write("BM", 0, "ascii")
  bmp.writeUInt32LE(fileSize, 2)
  bmp.writeUInt32LE(headerSize, 10)
  bmp.writeUInt32LE(124, 14)
  bmp.writeInt32LE(width, 18)
  bmp.writeInt32LE(-height, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(32, 28)
  bmp.writeUInt32LE(3, 30)
  bmp.writeUInt32LE(stride * height, 34)
  bmp.writeInt32LE(5669, 38)
  bmp.writeInt32LE(5669, 42)
  bmp.writeUInt32LE(0x00ff0000, 54)
  bmp.writeUInt32LE(0x0000ff00, 58)
  bmp.writeUInt32LE(0x000000ff, 62)
  bmp.writeUInt32LE(0xff000000, 66)
  bmp.write("BGRs", 70, "ascii")

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const source = (row * width + column) * 4
      const target = headerSize + row * stride + column * 4
      bmp[target] = pixels[source + 2] ?? 0
      bmp[target + 1] = pixels[source + 1] ?? 0
      bmp[target + 2] = pixels[source] ?? 0
      bmp[target + 3] = pixels[source + 3] ?? 255
    }
  }

  writeFileSync(path, bmp)
}
