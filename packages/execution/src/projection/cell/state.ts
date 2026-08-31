import { partialInputRecord, type Block, type Unit } from "@rika/product/execution-transcript-contract"
import { Cell as GeneralistCell } from "generalist/repl"
import type { RunEvent } from "generalist/runtime"
import { Option, Schema } from "effect"
import type { CellState, Node } from "../model"
import { bounded, optionalString, record, string } from "../values"
import { eventNotice, restartNotification } from "../recovery"
import { failureOutcome } from "./outcome"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
type CellNotice = Cell["notices"][number]
type ImageAttachment = Extract<Block, { readonly _tag: "ImageAttachment" }>
type CellFile = Cell["files"][number]
type CellHostCall = Cell["calls"][number]
type ToolProgressData = Extract<RunEvent.RunEvent, { readonly _tag: "ToolProgress" }>["data"]
type ToolResult = Extract<RunEvent.RunEvent, { readonly _tag: "ToolExecutionCompleted" }>["result"]["result"]

export const cellToolName = "typescript"
export const maxCellNotices = 32

const diffMediaTypes = new Set(["text/x-diff", "application/x-patch"])
const commentOnly = /^(?:\/\/|\/\*|\*)/u
const shellStatement = /Bun\.(?:\$`|spawn(?:Sync)?\s*\()/u

const sourceLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length)
const JsonFromString = Schema.fromJsonString(Schema.Json)
const resultValue = (value: string): Schema.Json => {
  const decoded = Schema.decodeOption(JsonFromString)(value)
  return Option.isSome(decoded) ? decoded.value : value
}

const meaningfulLines = (source: string): ReadonlyArray<string> =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !commentOnly.test(line))

const visualOf = (source: string): Cell["visual"] => {
  const lines = meaningfulLines(source)
  return lines.length === 1 && shellStatement.test(lines[0]!) ? "shell" : "ts"
}

const lineCounts = (patch: string) => {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

const hostCall = (event: Extract<GeneralistCell.CellEvent, { readonly _tag: "HostCall" }>): CellHostCall => {
  let call: CellHostCall = {
    id: event.requestId,
    module: event.module,
    operation: event.operation,
    inputSummary: bounded(event.inputSummary, 2_048),
    status: event.status,
  }
  if (event.durationMillis !== undefined) call = { ...call, durationMillis: event.durationMillis }
  if (event.message !== undefined) call = { ...call, message: bounded(event.message, 2_048) }
  return call
}

const updateCellEvent = (block: Cell, event: GeneralistCell.CellEvent): Cell => {
  switch (event._tag) {
    case "HostCall": {
      if (event.requestId.length === 0) return block
      const call = hostCall(event)
      const index = block.calls.findIndex((current) => current.id === call.id)
      return {
        ...block,
        calls: index < 0 ? [...block.calls, call] : block.calls.map((current, at) => (at === index ? call : current)),
      }
    }
    case "Stdout":
      return { ...block, output: { ...block.output, stdout: `${block.output.stdout}${optionalString(event.text)}` } }
    case "Stderr":
      return { ...block, output: { ...block.output, stderr: `${block.output.stderr}${optionalString(event.text)}` } }
    case "Result":
      return { ...block, result: resultValue(optionalString(event.value)) }
    default:
      return block
  }
}

const failedCell = (block: Cell, failure: GeneralistCell.CellFailure): Cell => {
  const outcome = failureOutcome(failure)
  const executionFailure = failure._tag === "generalist/repl/CellExecutionFailed" ? failure : undefined
  const failed: Cell = {
    ...block,
    status: outcome.status,
    output: {
      stdout: executionFailure?.stdout || block.output.stdout,
      stderr: executionFailure?.stderr || block.output.stderr,
    },
    epoch: "epoch" in failure ? failure.epoch : block.epoch,
  }
  if (executionFailure !== undefined) Object.assign(failed, { durationMillis: executionFailure.durationMillis })
  if (outcome.error !== undefined) Object.assign(failed, { error: outcome.error })
  return failed
}

export interface CellProjection {
  readonly cellState: (node: Node, rawId: string) => CellState
  readonly cellBlock: (node: Node, rawId: string) => Cell | undefined
  readonly openCell: (node: Node, rawId: string, source: string) => void
  readonly appendCellSource: (node: Node, rawId: string, delta: string) => void
  readonly progressCell: (node: Node, rawId: string, data: ToolProgressData) => void
  readonly completeCell: (node: Node, rawId: string, result: ToolResult, isFailure: boolean) => void
  readonly settleRunningCells: (node: Node, status: "complete" | "failed" | "cancelled") => void
}

export interface CellProjectionInput {
  readonly units: Map<string, Unit>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly recover: (node: Node, cell: CellState, active: boolean) => void
  readonly activeIds: (node: Node) => ReadonlyArray<string>
  readonly notice: (
    node: Node,
    family: string,
    titleText: string,
    detail: string,
    discriminator: string | number,
  ) => void
  readonly error: (
    node: Node,
    family: string,
    titleText: string,
    detail: string,
    discriminator: string | number,
  ) => string | undefined
}

export const makeCellProjection = (dependencies: CellProjectionInput): CellProjection => {
  const { units, localId, put, unit, recover, activeIds, notice, error } = dependencies

  const cellState = (node: Node, rawId: string): CellState => {
    const current = node.cells.get(rawId)
    if (current !== undefined) return current
    const created: CellState = {
      rawId,
      key: localId("cell-unit", node.publicId, rawId),
      blockId: localId("cell", node.publicId, rawId),
      partial: "",
    }
    node.cells.set(rawId, created)
    return created
  }

  const cellBlock = (node: Node, rawId: string): Cell | undefined => {
    const current = node.cells.get(rawId)
    const candidate = current === undefined ? undefined : units.get(current.key)
    return candidate?.content._tag === "Block" && candidate.content.block._tag === "Cell"
      ? candidate.content.block
      : undefined
  }

  const write = (node: Node, rawId: string, block: Cell) => {
    const state = cellState(node, rawId)
    put(unit(node, state.key, { _tag: "Block", block }))
    recover(node, state, block.status === "running" || block.status === "unknown")
  }

  const withSource = (block: Cell, source: string): Cell => ({
    ...block,
    visual: visualOf(source),
    source: { text: source, lines: sourceLines(source) },
  })

  const openCell = (node: Node, rawId: string, source: string) => {
    if (node.hidden) return
    const identity = cellState(node, rawId)
    const previous = cellBlock(node, rawId)
    const base: Cell = previous ?? {
      _tag: "Cell",
      id: identity.blockId,
      status: "running",
      visual: "ts",
      source: { text: "", lines: 0 },
      output: { stdout: "", stderr: "" },
      epoch: 0,
      notices: [],
      calls: [],
      files: [],
    }
    write(node, rawId, source.length === 0 && previous !== undefined ? base : withSource(base, source))
  }

  const appendCellSource = (node: Node, rawId: string, delta: string) => {
    const identity = cellState(node, rawId)
    identity.partial = `${identity.partial}${delta}`
    openCell(node, rawId, optionalString(partialInputRecord(identity.partial).code))
  }

  const appendNotice = (block: Cell, appended: CellNotice | undefined): Cell =>
    appended === undefined ? block : { ...block, notices: [...block.notices, appended].slice(-maxCellNotices) }

  const imageAttachment = (
    event: Extract<GeneralistCell.CellEvent, { readonly _tag: "Display" }>,
  ): ImageAttachment => ({
    _tag: "ImageAttachment",
    name: string(event.name, "attachment"),
    mediaType: event.mediaType,
    bytes: event.data.length,
  })

  const diffFile = (
    blockId: string,
    event: Extract<GeneralistCell.CellEvent, { readonly _tag: "Display" }>,
  ): CellFile | undefined => {
    const patch = event.data
    if (patch.length === 0) return undefined
    return {
      key: `${blockId}:${event.sequence}`,
      path: event.name ?? "workspace",
      kind: /^--- \/dev\/null$/m.test(patch) ? "add" : "update",
      patch,
      ...lineCounts(patch),
      preview: false,
      status: "complete",
    }
  }

  const progressCell = (node: Node, rawId: string, data: ToolProgressData) => {
    const block = cellBlock(node, rawId)
    if (block === undefined) return
    const raw = record(data)
    const decoded = Schema.decodeUnknownOption(GeneralistCell.CellEvent)(data)
    if (Option.isNone(decoded)) {
      if (raw._tag !== "KernelStarting" && raw._tag !== "KernelReady") return
      const cellNotice = eventNotice(data)
      const epoch = Schema.decodeUnknownOption(Schema.Int)(raw.epoch)
      const next = appendNotice({ ...block, epoch: Option.isSome(epoch) ? epoch.value : block.epoch }, cellNotice)
      write(node, rawId, next)
      return
    }
    const event = decoded.value
    let next = updateCellEvent(
      appendNotice({ ...block, epoch: "epoch" in event ? event.epoch : block.epoch }, eventNotice(event)),
      event,
    )
    if (event._tag === "Display") {
      const mediaType = optionalString(event.mediaType)
      if (mediaType.startsWith("image/"))
        put(
          unit(node, localId("cell-artifact", node.publicId, rawId, event.sequence), {
            _tag: "Block",
            block: imageAttachment(event),
          }),
        )
      else if (diffMediaTypes.has(mediaType)) {
        const file = diffFile(next.id, event)
        if (file !== undefined) next = { ...next, files: [...next.files, file] }
      }
    }
    write(node, rawId, next)
    const restarted = restartNotification(event)
    if (restarted !== undefined) notice(node, "kernel", restarted.title, restarted.detail, `${rawId}:${next.epoch}`)
  }

  const completeCell = (node: Node, rawId: string, result: ToolResult, isFailure: boolean) => {
    const block = cellBlock(node, rawId)
    if (block === undefined) return
    const success = Schema.decodeUnknownOption(GeneralistCell.CellResult)(result)
    if (!isFailure && Option.isSome(success)) {
      write(node, rawId, {
        ...block,
        status: "complete",
        result: resultValue(success.value.value),
        output: {
          stdout: success.value.stdout,
          stderr: success.value.stderr,
        },
        epoch: success.value.epoch,
        durationMillis: success.value.durationMillis,
      })
      return
    }
    if (!isFailure) return
    const decoded = Schema.decodeUnknownOption(GeneralistCell.CellFailure)(result)
    if (Option.isNone(decoded)) return
    const failure = decoded.value
    const outcome = failureOutcome(failure)
    write(node, rawId, failedCell(block, failure))
    if (outcome.diagnostic !== undefined)
      error(node, "cell", outcome.diagnostic.title, outcome.diagnostic.detail, rawId)
  }

  const settleRunningCells = (node: Node, status: "complete" | "failed" | "cancelled") => {
    for (const rawId of activeIds(node)) {
      const block = cellBlock(node, rawId)
      if (block?.status !== "running") continue
      write(node, rawId, { ...block, status })
    }
  }

  return {
    cellState,
    cellBlock,
    openCell,
    appendCellSource,
    progressCell,
    completeCell,
    settleRunningCells,
  }
}
