import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

interface Crop {
  readonly left: number
  readonly top: number
  readonly right_exclusive: number
  readonly bottom_exclusive: number
}

interface PixelInput {
  readonly red: number
  readonly green: number
  readonly blue: number
  readonly max: number
  readonly saturation: number
}

interface ImageData {
  readonly path: string
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

interface Measurement {
  readonly bbox: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null
  readonly width: number
  readonly height: number
  readonly pixel_count: number
  readonly mean_rgb: ReadonlyArray<number> | null
}

const args = Bun.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.error(
    "Usage: bun run scripts/parity-startup-measure.ts --amp <amp.png> --rika <rika.png> [--diff <diff.json>] [--visual-diff <diff.png>] [--row <n>] [--date <yyyy-mm-dd>] [--out <file.json>]",
  )
  process.exit(0)
}

const ampPath = requiredArg("--amp")
const rikaPath = requiredArg("--rika")
const diffPath = optionalArg("--diff")
const visualDiffPath = optionalArg("--visual-diff")
const row = optionalArg("--row")
const date = optionalArg("--date")
const outPath = optionalArg("--out")

const logoCrop: Crop = { left: 150, top: 180, right_exclusive: 875, bottom_exclusive: 1000 }
const welcomeCrop: Crop = { left: 850, top: 400, right_exclusive: 1300, bottom_exclusive: 700 }
const grid = { left: 217, top: 302, cell_width: 17, cell_height: 37, rows: 18, columns: 40 } as const
const tempDir = mkdtempSync(join(tmpdir(), "rika-startup-measure-"))

try {
  const amp = loadImage(ampPath, join(tempDir, `${basename(ampPath)}.bmp`))
  const rika = loadImage(rikaPath, join(tempDir, `${basename(rikaPath)}.bmp`))
  const diff = diffPath === undefined ? undefined : JSON.parse(readFileSync(diffPath, "utf8"))
  const output = {
    ...(row === undefined ? {} : { row: Number(row) }),
    ...(date === undefined ? {} : { date }),
    surface: "Startup & status line",
    state: "Empty startup, deep tier visible",
    verdict: "mismatch",
    method: {
      source: "screenshot RGB pixels converted via sips BMP output",
      logo_crop: logoCrop,
      logo_predicate: "max(rgb)>28 && saturation>0.18 && green>=red*0.65",
      welcome_crop: welcomeCrop,
      welcome_predicate: "max(rgb)>40 && saturation>0.15 && green>red*1.05 && green>blue*0.8",
      grid,
    },
    artifacts: {
      amp_screenshot: imageSummary(amp),
      rika_screenshot: imageSummary(rika),
      ...(diffPath === undefined
        ? {}
        : {
            pixel_diff: {
              path: diffPath,
              sha256: hashFile(diffPath),
              different_pixels: diff.different_pixels,
              different_percent: diff.different_percent,
              diff_bbox: diff.diff_bbox,
              total_absolute_channel_delta: diff.total_absolute_channel_delta,
              mean_absolute_channel_delta: diff.mean_absolute_channel_delta,
              max_channel_delta: diff.max_channel_delta,
            },
          }),
      ...(visualDiffPath === undefined
        ? {}
        : {
            visual_diff: {
              path: visualDiffPath,
              sha256: hashFile(visualDiffPath),
              width: amp.width,
              height: amp.height,
            },
          }),
    },
    measurements: {
      amp: measureSurface(amp),
      rika: measureSurface(rika),
    },
  }
  const derived = derivedDeltas(output.measurements.amp, output.measurements.rika)
  const finalOutput = { ...output, derived_deltas: derived }
  const json = `${JSON.stringify(finalOutput, null, 2)}\n`

  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, json)
  }

  process.stdout.write(json)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

function requiredArg(flag: string): string {
  const value = optionalArg(flag)
  if (value === undefined) throw new Error(`Missing ${flag}`)
  return value
}

function optionalArg(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
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
  const pixels = new Uint8Array(width * height * 3)

  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const sourceRow = rawHeight < 0 ? rowIndex : height - rowIndex - 1
    const sourceOffset = pixelOffset + sourceRow * stride
    const targetOffset = rowIndex * width * 3
    for (let column = 0; column < width; column += 1) {
      const sourcePixel = sourceOffset + column * 4
      const targetPixel = targetOffset + column * 3
      pixels[targetPixel] = bmp[sourcePixel + 2] ?? 0
      pixels[targetPixel + 1] = bmp[sourcePixel + 1] ?? 0
      pixels[targetPixel + 2] = bmp[sourcePixel] ?? 0
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

function measureSurface(image: ImageData) {
  return {
    logo: measure(
      image,
      logoCrop,
      ({ max, saturation, green, red }) => max > 28 && saturation > 0.18 && green >= red * 0.65,
    ),
    welcome_title: measure(
      image,
      welcomeCrop,
      ({ max, saturation, green, red, blue }) => max > 40 && saturation > 0.15 && green > red * 1.05 && green > blue * 0.8,
    ),
    grid: gridSummary(image),
  }
}

function measure(image: ImageData, crop: Crop, predicate: (input: PixelInput) => boolean): Measurement {
  let left = image.width
  let right = 0
  let top = image.height
  let bottom = 0
  let count = 0
  let redTotal = 0
  let greenTotal = 0
  let blueTotal = 0

  for (let rowIndex = crop.top; rowIndex < crop.bottom_exclusive; rowIndex += 1) {
    for (let column = crop.left; column < crop.right_exclusive; column += 1) {
      const offset = (rowIndex * image.width + column) * 3
      const red = image.pixels[offset] ?? 0
      const green = image.pixels[offset + 1] ?? 0
      const blue = image.pixels[offset + 2] ?? 0
      const max = Math.max(red, green, blue)
      const min = Math.min(red, green, blue)
      const saturation = max === 0 ? 0 : (max - min) / max

      if (predicate({ red, green, blue, max, saturation })) {
        left = Math.min(left, column)
        right = Math.max(right, column)
        top = Math.min(top, rowIndex)
        bottom = Math.max(bottom, rowIndex)
        count += 1
        redTotal += red
        greenTotal += green
        blueTotal += blue
      }
    }
  }

  if (count === 0) {
    return { bbox: null, width: 0, height: 0, pixel_count: 0, mean_rgb: null }
  }

  return {
    bbox: { left, top, right, bottom },
    width: right - left + 1,
    height: bottom - top + 1,
    pixel_count: count,
    mean_rgb: [redTotal / count, greenTotal / count, blueTotal / count].map((value) => Math.round(value)),
  }
}

function gridSummary(image: ImageData): ReadonlyArray<string> {
  const rows: Array<string> = []
  for (let rowIndex = 0; rowIndex < grid.rows; rowIndex += 1) {
    let line = ""
    for (let column = 0; column < grid.columns; column += 1) {
      let count = 0
      for (let y = grid.top + rowIndex * grid.cell_height; y < grid.top + (rowIndex + 1) * grid.cell_height; y += 1) {
        for (let x = grid.left + column * grid.cell_width; x < grid.left + (column + 1) * grid.cell_width; x += 1) {
          const offset = (y * image.width + x) * 3
          const red = image.pixels[offset] ?? 0
          const green = image.pixels[offset + 1] ?? 0
          const blue = image.pixels[offset + 2] ?? 0
          const max = Math.max(red, green, blue)
          const min = Math.min(red, green, blue)
          const saturation = max === 0 ? 0 : (max - min) / max
          if (max > 28 && saturation > 0.18 && green >= red * 0.65) count += 1
        }
      }
      line += count >= 55 ? "●" : count >= 16 ? "•" : count >= 4 ? "·" : " "
    }
    rows.push(line)
  }
  return rows
}

function derivedDeltas(amp: ReturnType<typeof measureSurface>, rika: ReturnType<typeof measureSurface>) {
  return {
    logo_left_delta: delta(amp.logo.bbox?.left, rika.logo.bbox?.left),
    logo_right_delta: delta(amp.logo.bbox?.right, rika.logo.bbox?.right),
    logo_top_delta: delta(amp.logo.bbox?.top, rika.logo.bbox?.top),
    logo_bottom_delta: delta(amp.logo.bbox?.bottom, rika.logo.bbox?.bottom),
    logo_pixel_count_delta: rika.logo.pixel_count - amp.logo.pixel_count,
    welcome_left_delta: delta(amp.welcome_title.bbox?.left, rika.welcome_title.bbox?.left),
    welcome_top_delta: delta(amp.welcome_title.bbox?.top, rika.welcome_title.bbox?.top),
  }
}

function delta(amp: number | undefined, rika: number | undefined): number | null {
  return amp === undefined || rika === undefined ? null : rika - amp
}

function imageSummary(image: ImageData) {
  return { path: image.path, sha256: image.sha256, width: image.width, height: image.height }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}
