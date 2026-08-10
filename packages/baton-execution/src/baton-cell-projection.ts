export const cellTextLimit = 16_384
export const cellSourceLimit = 65_536

import type { Block, Unit } from "@rika/product/execution-transcript-contract"
import { partialInputRecord } from "@rika/product/execution-transcript-contract"
import { type CellState, type Node } from "./baton-projector-model"
import { bounded, boundedHead, optionalString, record, string } from "./baton-projector-values"
import { eventNotice, nestedOperationNotice, restartNotification } from "./baton-recovery-projection"
import { failureOutcome } from "./baton-cell-outcome"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
type CellNotice = Cell["notices"][number]
type ImageAttachment = Extract<Block, { readonly _tag: "ImageAttachment" }>
type CellFile = Cell["files"][number]

export const cellToolName = "typescript"
export const maxCellNotices = 32
export const maxCellSummary = 240

const diffMediaTypes = new Set(["text/x-diff", "application/x-patch"])
const commentOnly = /^(?:\/\/|\/\*|\*)/u
const shellStatement = /Bun\.(?:\$`|spawn(?:Sync)?\s*\()/u

const sourceLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length)

const meaningfulLines = (source: string): ReadonlyArray<string> =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !commentOnly.test(line))

const summaryOf = (source: string): string => boundedHead(meaningfulLines(source)[0] ?? "", maxCellSummary)

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

const nonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0

const epochOf = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback

const truncationTotals = (value: unknown): { readonly droppedBytes: number; readonly droppedEvents: number } => {
  if (!Array.isArray(value)) return { droppedBytes: 0, droppedEvents: 0 }
  let droppedBytes = 0
  let droppedEvents = 0
  for (const entry of value) {
    const channel = record(entry)
    droppedBytes += nonNegative(channel.droppedBytes)
    droppedEvents += nonNegative(channel.droppedEvents)
  }
  return { droppedBytes, droppedEvents }
}

export interface CellProjection {
  readonly cellState: (node: Node, rawId: string) => CellState
  readonly cellBlock: (node: Node, rawId: string) => Cell | undefined
  readonly cellForOperationKey: (node: Node, operationKey: string) => CellState | undefined
  readonly openCell: (node: Node, rawId: string, source: string) => void
  readonly appendCellSource: (node: Node, rawId: string, delta: string) => void
  readonly progressCell: (node: Node, rawId: string, data: unknown) => void
  readonly completeCell: (node: Node, rawId: string, result: unknown, isFailure: boolean) => void
  readonly settleRunningCells: (node: Node, status: "complete" | "failed" | "cancelled") => void
}

export interface CellProjectionInput {
  readonly units: Map<string, Unit>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
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
  const { units, localId, put, unit, notice, error } = dependencies

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

  const cellForOperationKey = (node: Node, operationKey: string): CellState | undefined => {
    for (const [rawId, candidate] of node.cells)
      if (operationKey === rawId || operationKey.endsWith(`:${rawId}:${cellToolName}`)) return candidate
    return undefined
  }

  const write = (node: Node, rawId: string, block: Cell) => {
    put(unit(node, cellState(node, rawId).key, { _tag: "Block", block }))
  }

  const withSource = (block: Cell, source: string): Cell => {
    const text = bounded(source, cellSourceLimit)
    return {
      ...block,
      summary: summaryOf(text),
      visual: visualOf(text),
      source: { text, lines: sourceLines(text), truncated: source.length > cellSourceLimit },
    }
  }

  const openCell = (node: Node, rawId: string, source: string) => {
    if (node.hidden) return
    const identity = cellState(node, rawId)
    const previous = cellBlock(node, rawId)
    const base: Cell = previous ?? {
      _tag: "Cell",
      id: identity.blockId,
      status: "running",
      visual: "ts",
      summary: "",
      source: { text: "", lines: 0, truncated: false },
      output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
      epoch: 0,
      notices: [],
      files: [],
    }
    write(node, rawId, source.length === 0 && previous !== undefined ? base : withSource(base, source))
  }

  const appendCellSource = (node: Node, rawId: string, delta: string) => {
    const identity = cellState(node, rawId)
    identity.partial = bounded(`${identity.partial}${delta}`, cellSourceLimit * 2)
    openCell(node, rawId, optionalString(partialInputRecord(identity.partial).code))
  }

  const appendNotice = (block: Cell, appended: CellNotice | undefined): Cell =>
    appended === undefined ? block : { ...block, notices: [...block.notices, appended].slice(-maxCellNotices) }

  const imageAttachment = (event: Readonly<Record<string, unknown>>): ImageAttachment => ({
    _tag: "ImageAttachment",
    name: string(event.name, "attachment"),
    mediaType: optionalString(event.mediaType),
    bytes: optionalString(event.data).length,
  })

  const diffFile = (blockId: string, event: Readonly<Record<string, unknown>>): CellFile | undefined => {
    const patch = optionalString(event.data)
    if (patch.length === 0) return undefined
    return {
      key: `${blockId}:${nonNegative(event.sequence)}`,
      path: string(event.name, "workspace"),
      kind: /^--- \/dev\/null$/m.test(patch) ? "add" : "update",
      patch: bounded(patch, cellTextLimit),
      ...lineCounts(patch),
      preview: false,
      status: "complete",
    }
  }

  const progressCell = (node: Node, rawId: string, data: unknown) => {
    const block = cellBlock(node, rawId)
    if (block === undefined) return
    const event = record(data)
    const nested = nestedOperationNotice(event)
    if (nested !== undefined) {
      write(node, rawId, appendNotice(block, nested))
      return
    }
    let next = appendNotice({ ...block, epoch: epochOf(event.epoch, block.epoch) }, eventNotice(event))
    switch (event._tag) {
      case "Stdout":
        next = {
          ...next,
          output: {
            ...next.output,
            stdout: bounded(`${next.output.stdout}${optionalString(event.text)}`, cellTextLimit),
          },
        }
        break
      case "Stderr":
        next = {
          ...next,
          output: {
            ...next.output,
            stderr: bounded(`${next.output.stderr}${optionalString(event.text)}`, cellTextLimit),
          },
        }
        break
      case "Result":
        next = { ...next, result: bounded(optionalString(event.value), cellTextLimit) }
        break
      case "OutputTruncated":
        next = {
          ...next,
          output: {
            ...next.output,
            droppedBytes: next.output.droppedBytes + nonNegative(event.droppedBytes),
            droppedEvents: next.output.droppedEvents + nonNegative(event.droppedEvents),
          },
        }
        break
      case "Display": {
        const mediaType = optionalString(event.mediaType)
        if (mediaType.startsWith("image/"))
          put(
            unit(node, localId("cell-artifact", node.publicId, rawId, nonNegative(event.sequence)), {
              _tag: "Block",
              block: imageAttachment(event),
            }),
          )
        else if (diffMediaTypes.has(mediaType)) {
          const file = diffFile(next.id, event)
          if (file !== undefined) next = { ...next, files: [...next.files, file] }
        }
        break
      }
      default:
        break
    }
    write(node, rawId, next)
    const restarted = restartNotification(event)
    if (restarted !== undefined) notice(node, "kernel", restarted.title, restarted.detail, `${rawId}:${next.epoch}`)
  }

  const completeCell = (node: Node, rawId: string, result: unknown, isFailure: boolean) => {
    const block = cellBlock(node, rawId)
    if (block === undefined) return
    const value = record(result)
    const totals = truncationTotals(value.truncation)
    const duration =
      typeof value.durationMillis === "number" && Number.isFinite(value.durationMillis)
        ? { durationMillis: value.durationMillis }
        : {}
    if (!isFailure) {
      write(node, rawId, {
        ...block,
        status: "complete",
        result: bounded(optionalString(value.value), cellTextLimit),
        output: {
          stdout: bounded(optionalString(value.stdout), cellTextLimit),
          stderr: bounded(optionalString(value.stderr), cellTextLimit),
          ...totals,
        },
        epoch: epochOf(value.epoch, block.epoch),
        ...duration,
      })
      return
    }
    const outcome = failureOutcome(result)
    const stdout = optionalString(value.stdout)
    const stderr = optionalString(value.stderr)
    write(node, rawId, {
      ...block,
      status: outcome.status,
      output: {
        stdout: stdout.length === 0 ? block.output.stdout : bounded(stdout, cellTextLimit),
        stderr: stderr.length === 0 ? block.output.stderr : bounded(stderr, cellTextLimit),
        droppedBytes: Math.max(block.output.droppedBytes, totals.droppedBytes),
        droppedEvents: Math.max(block.output.droppedEvents, totals.droppedEvents),
      },
      epoch: epochOf(value.epoch, block.epoch),
      ...duration,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    })
    if (outcome.diagnostic !== undefined)
      error(node, "cell", outcome.diagnostic.title, outcome.diagnostic.detail, rawId)
  }

  const settleRunningCells = (node: Node, status: "complete" | "failed" | "cancelled") => {
    for (const rawId of node.cells.keys()) {
      const block = cellBlock(node, rawId)
      if (block?.status !== "running") continue
      write(node, rawId, { ...block, status })
    }
  }

  return {
    cellState,
    cellBlock,
    cellForOperationKey,
    openCell,
    appendCellSource,
    progressCell,
    completeCell,
    settleRunningCells,
  }
}
