import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

interface Launch {
  readonly label: "amp" | "rika"
  readonly run_id: string
  readonly command: string
  readonly ghostty_pid: number
  readonly window_id: number
  readonly window_bounds: WindowBounds
}

interface Capture {
  readonly frame: number
  readonly amp: ImageSummary
  readonly rika: ImageSummary
  readonly same_dimensions: boolean
}

interface ImageSummary {
  readonly path: string
  readonly sha256: string
  readonly width: number
  readonly height: number
}

interface WindowBounds {
  readonly width: number
  readonly height: number
}

interface WindowInfo {
  readonly id: number
  readonly bounds: WindowBounds
}

interface GeometrySummary {
  readonly all_pairs_same_dimensions: boolean
  readonly amp_dimensions: ReadonlyArray<string>
  readonly rika_dimensions: ReadonlyArray<string>
  readonly distinct_amp_dimensions: ReadonlyArray<string>
  readonly distinct_rika_dimensions: ReadonlyArray<string>
  readonly distinct_pair_dimensions: ReadonlyArray<string>
}

const args = Bun.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.error(
    "Usage: bun run scripts/parity-startup-burst-capture.ts --row <n> [--count <n>] [--interval-ms <n>] [--settle-ms <n>] [--focus-ms <n>] [--trigger ctrl+o|ctrl+s] [--trigger-settle-ms <n>] [--file-prefix <name>] [--surface <text>] [--state <text>] [--require-same-dimensions] [--workspace <path>] [--out-dir <dir>] [--metadata <file.json>]",
  )
  process.exit(0)
}

const row = Number(requiredArg("--row"))
const filePrefix = optionalArg("--file-prefix") ?? "startup-empty"
const surface = optionalArg("--surface") ?? "Startup & status line"
const state = optionalArg("--state") ?? "Empty startup, deep tier visible"
const count = Number(optionalArg("--count") ?? "8")
const intervalMs = Number(optionalArg("--interval-ms") ?? "100")
const settleMs = Number(optionalArg("--settle-ms") ?? "1200")
const focusMs = Number(optionalArg("--focus-ms") ?? "150")
const trigger = optionalArg("--trigger")
const triggerSettleMs = Number(optionalArg("--trigger-settle-ms") ?? "500")
const requireSameDimensions = args.includes("--require-same-dimensions")
const workspace = optionalArg("--workspace") ?? process.cwd()
const outDir = optionalArg("--out-dir") ?? "docs/parity/screenshots"
const metadataPath = optionalArg("--metadata") ?? `docs/parity/metadata/${filePrefix}-${pad(row)}-burst-capture.json`
const runToken = `rika-parity-${filePrefix}-${pad(row)}-${Date.now()}`
const launches: Array<Launch> = []

if (!Number.isInteger(row) || row <= 0) throw new Error("row must be a positive integer")
if (!/^[a-z0-9][a-z0-9-]*$/.test(filePrefix)) throw new Error("file-prefix must be a lowercase slug")
if (!Number.isInteger(count) || count <= 0) throw new Error("count must be a positive integer")
if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("interval-ms must be a non-negative integer")
if (!Number.isInteger(settleMs) || settleMs < 0) throw new Error("settle-ms must be a non-negative integer")
if (!Number.isInteger(focusMs) || focusMs < 0) throw new Error("focus-ms must be a non-negative integer")
if (!Number.isInteger(triggerSettleMs) || triggerSettleMs < 0) throw new Error("trigger-settle-ms must be a non-negative integer")
if (trigger !== undefined && trigger !== "ctrl+o" && trigger !== "ctrl+s")
  throw new Error("Only --trigger ctrl+o and --trigger ctrl+s are supported")

await main()

async function main(): Promise<void> {
  const dataDir = `/tmp/rika-parity-data-source-${pad(row)}`
  const ampCommand = `cd ${shellQuote(workspace)} && exec env RIKA_PARITY_RUN_ID=${shellQuote(`${runToken}-amp`)} AMP_SKIP_UPDATE_CHECK=1 amp`
  const rikaCommand = `cd ${shellQuote(workspace)} && exec env RIKA_PARITY_RUN_ID=${shellQuote(`${runToken}-rika`)} RIKA_DATA_DIR=${shellQuote(dataDir)} bun packages/cli/src/main.ts interactive --ephemeral --mode deep`

  try {
    launches.push(await launch("amp", `${runToken}-amp`, ampCommand))
    launches.push(await launch("rika", `${runToken}-rika`, rikaCommand))

    await Bun.sleep(settleMs)
    if (trigger !== undefined) {
      for (const label of ["amp", "rika"] as const) {
        await focusProcess(launchPid(label))
        await Bun.sleep(focusMs)
        await pressTrigger(trigger)
      }
      await Bun.sleep(triggerSettleMs)
    }

    const captures: Array<Capture> = []
    mkdirSync(join(outDir, "amp"), { recursive: true })
    mkdirSync(join(outDir, "rika"), { recursive: true })

    for (let index = 1; index <= count; index += 1) {
      const ampPath = join(outDir, "amp", `${filePrefix}-${pad(row)}-${pad(index)}.png`)
      const rikaPath = join(outDir, "rika", `${filePrefix}-${pad(row)}-${pad(index)}.png`)
      await focusProcess(launchPid("amp"))
      await Bun.sleep(focusMs)
      await capture(windowId("amp"), ampPath)
      await focusProcess(launchPid("rika"))
      await Bun.sleep(focusMs)
      await capture(windowId("rika"), rikaPath)
      const amp = imageSummary(ampPath)
      const rika = imageSummary(rikaPath)
      captures.push({ frame: index, amp, rika, same_dimensions: sameDimensions(amp, rika) })
      if (index < count) await Bun.sleep(intervalMs)
    }

    const geometry = geometrySummary(captures)
    if (requireSameDimensions && !geometryStable(geometry)) {
      throw new Error(`Unstable capture dimensions: ${JSON.stringify(geometry)}`)
    }

    const output = {
      row,
      generated_at: new Date().toISOString(),
      surface,
      state,
      method: {
        launcher: "Ghostty.app via open -na and CoreGraphics window-id discovery",
        count,
        interval_ms: intervalMs,
        settle_ms: settleMs,
        focus_ms: focusMs,
        trigger: trigger ?? null,
        trigger_settle_ms: triggerSettleMs,
        require_same_dimensions: requireSameDimensions,
        workspace,
        out_dir: outDir,
      },
      launches,
      geometry,
      captures,
    }

    mkdirSync(dirname(metadataPath), { recursive: true })
    writeFileSync(metadataPath, `${JSON.stringify(output, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } finally {
    await cleanup()
  }
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

async function launch(label: "amp" | "rika", runId: string, command: string): Promise<Launch> {
  const opened = Bun.spawnSync([
    "open",
    "-na",
    "Ghostty.app",
    "--args",
    "--font-size=14",
    "--window-width=100",
    "--window-height=30",
    "-e",
    "zsh",
    "-lc",
    command,
  ])

  if (!opened.success) {
    throw new Error(`Failed to open ${label} Ghostty: ${opened.stderr.toString()}`)
  }

  const ghosttyPid = await waitForGhosttyPid(runId)
  const window = await waitForWindow(ghosttyPid)
  return { label, run_id: runId, command, ghostty_pid: ghosttyPid, window_id: window.id, window_bounds: window.bounds }
}

async function waitForGhosttyPid(runId: string): Promise<number> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const pid = ghosttyPidForRun(runId)
    if (pid !== undefined) return pid
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for Ghostty PID for ${runId}`)
}

function ghosttyPidForRun(runId: string): number | undefined {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" })
  if (!ps.success) throw new Error(`ps failed: ${ps.stderr.toString()}`)
  for (const line of ps.stdout.toString().split("\n")) {
    if (!line.includes(runId)) continue
    if (!line.includes("Ghostty.app/Contents/MacOS/ghostty")) continue
    const pid = Number(line.trim().split(/\s+/, 1)[0])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return undefined
}

async function waitForWindow(pid: number): Promise<WindowInfo> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const window = windowForPid(pid)
    if (window !== undefined) return window
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for Ghostty window for PID ${pid}`)
}

function windowForPid(pid: number): WindowInfo | undefined {
  const swift = Bun.spawnSync(["swift", "-e", windowListSource(pid)], { stdout: "pipe", stderr: "pipe" })
  if (!swift.success) throw new Error(`swift failed: ${swift.stderr.toString()}`)
  const [idText, widthText, heightText] = swift.stdout.toString().trim().split("\t")
  const id = Number(idText)
  const width = Number(widthText)
  const height = Number(heightText)
  return Number.isInteger(id) && id > 0 && Number.isFinite(width) && Number.isFinite(height)
    ? { id, bounds: { width, height } }
    : undefined
}

function windowListSource(pid: number): string {
  return [
    "import CoreGraphics",
    "import Foundation",
    `let target = ${pid}`,
    "let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)",
    "let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []",
    "var bestId = 0",
    "var bestWidth = 0.0",
    "var bestHeight = 0.0",
    "var bestArea = 0.0",
    "for window in windows {",
    "  let ownerPid = window[kCGWindowOwnerPID as String] as? Int ?? -1",
    "  let ownerName = window[kCGWindowOwnerName as String] as? String ?? \"\"",
    "  if ownerPid == target && ownerName == \"Ghostty\" {",
    "    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]",
    "    let width = bounds[\"Width\"] as? Double ?? 0.0",
    "    let height = bounds[\"Height\"] as? Double ?? 0.0",
    "    let area = width * height",
    "    if area > bestArea {",
    "      bestId = window[kCGWindowNumber as String] as? Int ?? 0",
    "      bestWidth = width",
    "      bestHeight = height",
    "      bestArea = area",
    "    }",
    "  }",
    "}",
    "if bestId > 0 {",
    "  print(\"\\(bestId)\\t\\(Int(bestWidth))\\t\\(Int(bestHeight))\")",
    "}",
  ].join("\n")
}

function windowId(label: "amp" | "rika"): number {
  const launchRecord = launches.find((item) => item.label === label)
  if (launchRecord === undefined) throw new Error(`Missing ${label} launch`)
  return launchRecord.window_id
}

function launchPid(label: "amp" | "rika"): number {
  const launchRecord = launches.find((item) => item.label === label)
  if (launchRecord === undefined) throw new Error(`Missing ${label} launch`)
  return launchRecord.ghostty_pid
}

async function focusProcess(pid: number): Promise<void> {
  const result = Bun.spawn(["osascript", "-e", `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await result.exited
  if (code !== 0) {
    throw new Error(`Could not focus Ghostty PID ${pid}: ${await new Response(result.stderr).text()}`)
  }
}

async function pressTrigger(value: string): Promise<void> {
  const script =
    value === "ctrl+o"
      ? 'tell application "System Events" to keystroke "o" using control down'
      : value === "ctrl+s"
        ? 'tell application "System Events" to keystroke "s" using control down'
        : ""
  const result = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
  const code = await result.exited
  if (code !== 0) {
    throw new Error(`Could not press ${value}: ${await new Response(result.stderr).text()}`)
  }
}

async function capture(window: number, path: string): Promise<void> {
  const result = Bun.spawn(["screencapture", "-x", "-l", String(window), path], { stdout: "pipe", stderr: "pipe" })
  const code = await result.exited
  if (code !== 0) {
    throw new Error(`screencapture failed for ${path}: ${await new Response(result.stderr).text()}`)
  }
}

function imageSummary(path: string): ImageSummary {
  if (!existsSync(path)) throw new Error(`Missing screenshot ${path}`)
  const dimensions = imageDimensions(path)
  return {
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    width: dimensions.width,
    height: dimensions.height,
  }
}

function imageDimensions(path: string): { readonly width: number; readonly height: number } {
  const result = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], { stdout: "pipe", stderr: "pipe" })
  if (!result.success) throw new Error(`sips failed for ${path}: ${result.stderr.toString()}`)
  const output = result.stdout.toString()
  const width = Number(/pixelWidth:\s+(\d+)/.exec(output)?.[1])
  const height = Number(/pixelHeight:\s+(\d+)/.exec(output)?.[1])
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`Could not read dimensions for ${path}`)
  return { width, height }
}

function sameDimensions(amp: ImageSummary, rika: ImageSummary): boolean {
  return amp.width === rika.width && amp.height === rika.height
}

function geometrySummary(captures: ReadonlyArray<Capture>): GeometrySummary {
  const ampDimensions = captures.map((item) => dimensionString(item.amp))
  const rikaDimensions = captures.map((item) => dimensionString(item.rika))
  const pairDimensions = captures.map((item) => `${dimensionString(item.amp)}:${dimensionString(item.rika)}`)
  return {
    all_pairs_same_dimensions: captures.every((item) => item.same_dimensions),
    amp_dimensions: ampDimensions,
    rika_dimensions: rikaDimensions,
    distinct_amp_dimensions: [...new Set(ampDimensions)],
    distinct_rika_dimensions: [...new Set(rikaDimensions)],
    distinct_pair_dimensions: [...new Set(pairDimensions)],
  }
}

function geometryStable(geometry: GeometrySummary): boolean {
  return (
    geometry.all_pairs_same_dimensions &&
    geometry.distinct_amp_dimensions.length === 1 &&
    geometry.distinct_rika_dimensions.length === 1 &&
    geometry.distinct_pair_dimensions.length === 1
  )
}

function dimensionString(image: ImageSummary): string {
  return `${image.width}x${image.height}`
}

async function cleanup(): Promise<void> {
  const pids = new Set<number>()
  for (const launchRecord of launches) pids.add(launchRecord.ghostty_pid)
  for (const pid of descendantProcessIds([...pids])) pids.add(pid)
  for (const pid of runProcessIds(runToken)) pids.add(pid)
  const ordered = [...pids].toSorted((a, b) => b - a)
  for (const pid of ordered) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  await Bun.sleep(500)
  for (const pid of ordered) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

function descendantProcessIds(roots: ReadonlyArray<number>): ReadonlyArray<number> {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" })
  if (!ps.success) return []
  const children = new Map<number, Array<number>>()
  for (const line of ps.stdout.toString().split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/, 2)
    const pid = Number(pidText)
    const ppid = Number(ppidText)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const existing = children.get(ppid) ?? []
    existing.push(pid)
    children.set(ppid, existing)
  }

  const out: Array<number> = []
  const stack = [...roots]
  while (stack.length > 0) {
    const parent = stack.pop()
    if (parent === undefined) continue
    for (const child of children.get(parent) ?? []) {
      if (child === process.pid) continue
      out.push(child)
      stack.push(child)
    }
  }
  return out
}

function runProcessIds(token: string): ReadonlyArray<number> {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" })
  if (!ps.success) return []
  const pids: Array<number> = []
  for (const line of ps.stdout.toString().split("\n")) {
    if (!line.includes(token)) continue
    const pid = Number(line.trim().split(/\s+/, 1)[0])
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid)
  }
  return pids
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}
