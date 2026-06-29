import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"

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

const args = Bun.argv.slice(2)

if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
  console.error("Usage: bun run scripts/parity-pixel-diff.ts <amp.png> <rika.png> [--out <file.json>] [--diff-image <file.png>]")
  process.exit(args.length < 2 ? 1 : 0)
}

const [ampPath, rikaPath] = args
const outIndex = args.indexOf("--out")
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined
const diffImageIndex = args.indexOf("--diff-image")
const diffImagePath = diffImageIndex >= 0 ? args[diffImageIndex + 1] : undefined

if (ampPath === undefined || rikaPath === undefined) {
  throw new Error("Missing screenshot paths")
}

const tempDir = mkdtempSync(join(tmpdir(), "rika-parity-diff-"))

try {
  const amp = loadImage(ampPath, join(tempDir, `${basename(ampPath)}.bmp`))
  const rika = loadImage(rikaPath, join(tempDir, `${basename(rikaPath)}.bmp`))
  const diffImageBmpPath = diffImagePath === undefined ? undefined : join(tempDir, `${basename(diffImagePath)}.bmp`)
  const diff = compare(amp, rika, diffImagePath, diffImageBmpPath)
  const json = `${JSON.stringify(diff, null, 2)}\n`

  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, json)
  }

  process.stdout.write(json)
  process.exit(diff.same_dimensions && diff.different_pixels === 0 ? 0 : 1)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
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

function compare(amp: ImageData, rika: ImageData, requestedDiffImagePath: string | undefined, diffImageBmpPath: string | undefined) {
  const sameDimensions = amp.width === rika.width && amp.height === rika.height
  const width = Math.min(amp.width, rika.width)
  const height = Math.min(amp.height, rika.height)
  const diffWidth = Math.max(amp.width, rika.width)
  const diffHeight = Math.max(amp.height, rika.height)
  const ampPixels = amp.width * amp.height
  const rikaPixels = rika.width * rika.height
  const overlapPixels = width * height
  const diffPixelDenominator = ampPixels + rikaPixels - overlapPixels
  let differentPixels = ampPixels + rikaPixels - overlapPixels * 2
  let totalAbsoluteChannelDelta = 0
  let maxChannelDelta = 0
  let bbox: DiffBox | undefined
  const diffPixels = requestedDiffImagePath === undefined ? undefined : new Uint8Array(diffWidth * diffHeight * 4)

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const ampOffset = (row * amp.width + column) * 4
      const rikaOffset = (row * rika.width + column) * 4
      const dr = Math.abs((amp.pixels[ampOffset] ?? 0) - (rika.pixels[rikaOffset] ?? 0))
      const dg = Math.abs((amp.pixels[ampOffset + 1] ?? 0) - (rika.pixels[rikaOffset + 1] ?? 0))
      const db = Math.abs((amp.pixels[ampOffset + 2] ?? 0) - (rika.pixels[rikaOffset + 2] ?? 0))
      const da = Math.abs((amp.pixels[ampOffset + 3] ?? 0) - (rika.pixels[rikaOffset + 3] ?? 0))
      const delta = dr + dg + db + da
      totalAbsoluteChannelDelta += delta
      maxChannelDelta = Math.max(maxChannelDelta, dr, dg, db, da)

      if (delta > 0) {
        differentPixels += 1
        setPixel(diffPixels, diffWidth, column, row, 255, Math.min(255, delta), 96, 255)
        bbox =
          bbox === undefined
            ? { left: column, top: row, right: column, bottom: row }
            : {
                left: Math.min(bbox.left, column),
                top: Math.min(bbox.top, row),
                right: Math.max(bbox.right, column),
                bottom: Math.max(bbox.bottom, row),
              }
      }
    }
  }

  if (!sameDimensions) {
    for (let row = 0; row < diffHeight; row += 1) {
      for (let column = 0; column < diffWidth; column += 1) {
        const inAmp = column < amp.width && row < amp.height
        const inRika = column < rika.width && row < rika.height
        if (inAmp !== inRika) setPixel(diffPixels, diffWidth, column, row, 255, 214, 10, 255)
      }
    }
  }

  if (requestedDiffImagePath !== undefined && diffImageBmpPath !== undefined) {
    mkdirSync(dirname(requestedDiffImagePath), { recursive: true })
    writeBmp(diffImageBmpPath, diffWidth, diffHeight, diffPixels ?? new Uint8Array(diffWidth * diffHeight * 4))
    const converted = Bun.spawnSync(["sips", "-s", "format", "png", diffImageBmpPath, "--out", requestedDiffImagePath], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (!converted.success) {
      throw new Error(`sips failed for diff image ${requestedDiffImagePath}: ${converted.stderr.toString()}`)
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
    amp: { path: amp.path, sha256: amp.sha256, width: amp.width, height: amp.height },
    rika: { path: rika.path, sha256: rika.sha256, width: rika.width, height: rika.height },
    same_dimensions: sameDimensions,
    compared_pixels: comparedPixels,
    diff_pixel_denominator: diffPixelDenominator,
    different_pixels: differentPixels,
    different_percent: diffPixelDenominator === 0 ? 0 : (differentPixels / diffPixelDenominator) * 100,
    diff_bbox: diffBox,
    visual_diff_image: requestedDiffImagePath ?? null,
    total_absolute_channel_delta: totalAbsoluteChannelDelta,
    mean_absolute_channel_delta: comparedPixels === 0 ? 0 : totalAbsoluteChannelDelta / (comparedPixels * 4),
    max_channel_delta: maxChannelDelta,
  }
}

function setPixel(
  pixels: Uint8Array | undefined,
  width: number,
  column: number,
  row: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
): void {
  if (pixels === undefined) return
  const offset = (row * width + column) * 4
  pixels[offset] = red
  pixels[offset + 1] = green
  pixels[offset + 2] = blue
  pixels[offset + 3] = alpha
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
