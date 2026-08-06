import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import { Option, Schema } from "effect"
import { partialInputRecord } from "./partial-tool-input"
import type { Block } from "../schema/transcript-presentation-model"
import { ToolFile as ToolFileSchema, ToolProcess as ToolProcessSchema } from "../schema/transcript-presentation-model"
type ToolFile = typeof ToolFileSchema.Type
type ToolProcess = typeof ToolProcessSchema.Type
import type { Unit } from "../schema/transcript-unit"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { OwnedFold, MutableMutation } from "./transcript-fold-state"
import { foldState } from "./transcript-fold-state"
import { mutationOperations } from "./transcript-fold-mutation"
const { toolAt, updateTool, upsertUnit, unifiedFiles } = mutationOperations
const {
  callPayload,
  encodeInput,
  enumerateKeys,
  outputText,
  rawToolId,
  record,
  resultPayload,
  string,
  toolBlockFrom,
  toolKey,
  makeUnit,
} = foldState
import { identityKey, scopedIdentity } from "../ordering/transcript-unit-identity"

const lineCounts = (patch: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

const inputRecord = (input: string): Record<string, unknown> => {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input)
  if (Option.isNone(decoded)) return partialInputRecord(input)
  return typeof decoded.value === "string" ? { path: decoded.value, command: decoded.value } : record(decoded.value)
}

const inputString = (input: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) if (typeof input[key] === "string" && input[key].length > 0) return input[key]
  return undefined
}

const inputContentText = (input: Record<string, unknown>): string | undefined => {
  if (!Array.isArray(input.input)) return undefined
  const text = input.input
    .flatMap((part) => {
      const value = record(part)
      return value.type === "text" && typeof value.text === "string" ? [value.text] : []
    })
    .join("\n")
  return text.length === 0 ? undefined : text
}

const detailFor = (name: string, inputText: string): string => {
  const normalizedName = name.toLowerCase()
  const input = inputRecord(inputText)
  const path = inputString(input, ["path", "file_path", "file"])
  if (normalizedName === "read") {
    const readRange = Array.isArray(input.read_range) ? input.read_range : undefined
    if (typeof readRange?.[0] === "number" && typeof readRange[1] === "number")
      return `${path ?? name} L${readRange[0]}-${readRange[1]}`
    const offset = typeof input.offset === "number" ? input.offset : 1
    const limit = typeof input.limit === "number" ? input.limit : undefined
    return `${path ?? name}${limit === undefined ? "" : ` L${offset}-${offset + Math.max(0, limit - 1)}`}`
  }
  if (normalizedName === "grep")
    return `${path === undefined ? "" : `${path} `}"${inputString(input, ["pattern"]) ?? ""}"`.trim()
  if (normalizedName === "bash") {
    const command = inputString(input, ["command", "cmd", "script"]) ?? ""
    const args = Array.isArray(input.args)
      ? input.args.filter((value): value is string => typeof value === "string")
      : []
    return [command, ...args].join(" ").trim()
  }
  if (normalizedName === "shell_command_status") return inputString(input, ["processId", "process_id"]) ?? ""
  if (normalizedName === "web_search") return inputString(input, ["objective", "query"]) ?? ""
  if (normalizedName === "read_web_page") return inputString(input, ["url"]) ?? ""
  if (normalizedName === "search_threads") return inputString(input, ["query"]) ?? ""
  if (normalizedName === "read_thread_transcript") return inputString(input, ["threadId", "thread_id", "id"]) ?? ""
  if (path !== undefined) return path
  return inputString(input, ["description", "prompt", "task", "query", "objective"]) ?? inputContentText(input) ?? ""
}

const inputFiles = (id: string, name: string, inputText: string): ReadonlyArray<ToolFile> => {
  const input = inputRecord(inputText)
  const path = inputString(input, ["path", "file_path", "file"])
  if (path === undefined || (name !== "write" && name !== "edit")) return []
  const patch =
    name === "write"
      ? `--- /dev/null\n+++ b/${path}\n${string(input.content)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      : `--- a/${path}\n+++ b/${path}\n${string(input.old_str ?? input.oldText)
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${string(input.new_str ?? input.newText)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
  return [
    {
      key: `${id}:0`,
      path,
      kind: name === "write" ? "add" : "update",
      patch,
      ...lineCounts(patch),
      preview: true,
      status: "running",
    },
  ]
}

const toolBlock = ({
  id,
  name,
  input,
  previous,
}: {
  readonly id: string
  readonly name: string
  readonly input: string
  readonly previous: Extract<Block, { _tag: "ToolCall" }> | undefined
}) => ({
  _tag: "ToolCall" as const,
  id,
  name,
  input,
  status: previous?.status ?? ("running" as const),
  presentation: previous?.presentation ?? Catalog.resolvePresentation(name),
  detail: detailFor(name, input),
  files: inputFiles(id, name, input),
  ...(previous?.output === undefined ? {} : { output: previous.output }),
  ...(previous?.process === undefined ? {} : { process: previous.process }),
  ...(previous?.parentId === undefined ? {} : { parentId: previous.parentId }),
  ...(previous?.childId === undefined ? {} : { childId: previous.childId }),
})

const processOutput = (process: ToolProcess | undefined): string => `${process?.stdout ?? ""}${process?.stderr ?? ""}`

const initialProcessOutput = (tool: Extract<Block, { _tag: "ToolCall" }>): string | undefined => {
  const raw = processOutput(tool.process)
  return tool.process?.truncated !== true && tool.output === raw.trim() ? raw : tool.output
}

const boundedSuffix = (text: string, limit: number): string => {
  const suffix = text.slice(-limit)
  const first = suffix.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? suffix.slice(1) : suffix
}

const foldOutput = (
  current: string | undefined,
  next: string,
  limit: number,
): { readonly output?: string; readonly truncated: boolean } => {
  const combined = `${current ?? ""}${next}`
  if (combined.length <= limit) return { ...(combined.length === 0 ? {} : { output: combined }), truncated: false }
  return { output: boundedSuffix(combined, limit), truncated: true }
}

const processResult = (output: unknown): ToolProcess | undefined => {
  const value = record(output)
  const process = {
    ...(typeof value.running === "boolean" ? { running: value.running } : {}),
    ...(typeof value.processId === "string" ? { processId: value.processId } : {}),
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(typeof value.stdout === "string" ? { stdout: value.stdout } : {}),
    ...(typeof value.stderr === "string" ? { stderr: value.stderr } : {}),
    ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
  }
  return Object.keys(process).length === 0 ? undefined : process
}

const applyToolDelta = ({
  value,
  change,
  turnId,
  event,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly turnId: string
  readonly event: SourceEvent
}): void => {
  const payload = callPayload(event)
  const rawId = rawToolId(event)
  const id = scopedIdentity(turnId, rawId)
  const previous = toolAt(value, id)
  const delta = string(payload.delta ?? event.text)
  const input = `${previous?.input ?? ""}${delta}`
  const name = string(payload.tool_name ?? payload.name, previous?.name ?? "tool")
  const block = toolBlock({ id, name, input, previous })
  upsertUnit(
    value,
    change,
    makeUnit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const applyToolRequested = ({
  value,
  change,
  turnId,
  event,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly turnId: string
  readonly event: SourceEvent
}): void => {
  const payload = callPayload(event)
  const rawId = rawToolId(event)
  const id = scopedIdentity(turnId, rawId)
  const previous = toolAt(value, id)
  const name = string(payload.tool_name ?? payload.name, previous?.name ?? "tool")
  const input = encodeInput(payload.input)
  const base = toolBlock({ id, name, input, previous })
  const processId =
    base.presentation.rowDisplay === "continuation"
      ? inputString(inputRecord(input), ["processId", "process_id"])
      : undefined
  let parent: Unit | undefined
  if (processId !== undefined) {
    const candidates = value.toolsByProcess.get(processId)
    if (candidates !== undefined)
      for (const unit of enumerateKeys(value, candidates)) {
        const tool = toolBlockFrom(unit)
        if (tool?.name === "bash") {
          parent = unit
          break
        }
      }
  }
  const parentTool = parent === undefined ? undefined : toolBlockFrom(parent)
  const block = parentTool === undefined ? base : { ...base, detail: parentTool.detail, parentId: parentTool.id }
  upsertUnit(
    value,
    change,
    makeUnit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const applyToolResult = ({
  value,
  change,
  turnId,
  event,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly turnId: string
  readonly event: SourceEvent
}): void => {
  const payload = resultPayload(event)
  const rawId = rawToolId(event)
  const id = scopedIdentity(turnId, rawId)
  const requested = toolAt(value, id)
  const output = payload.output
  const outputStatus = string(record(output).status).toLowerCase()
  const process = processResult(output)
  const failed =
    payload.is_failure === true ||
    typeof payload.error === "string" ||
    record(output)._tag === "ToolError" ||
    outputStatus === "failed" ||
    (process?.exitCode !== undefined && process.exitCode !== 0)
  const cancelled = outputStatus === "cancelled" || outputStatus === "canceled"
  const spawned = record(output)._tag === "Spawned" && outputStatus === "running"
  const errorText = string(payload.error, string(record(output).message))
  const resultText = failed && errorText.length > 0 ? errorText : outputText(output)
  const diff = string(record(output).diff)
  const updated = updateTool(value, change, id, event.sequence, (tool) => {
    let status: Extract<Block, { _tag: "ToolCall" }>["status"] = "complete"
    if (failed) status = "failed"
    else if (cancelled) status = "cancelled"
    else if (spawned || (process?.running === true && tool.presentation.rowDisplay !== "continuation"))
      status = "running"
    return {
      ...tool,
      status,
      ...(spawned ? {} : { output: resultText }),
      ...(process === undefined ? {} : { process: { ...tool.process, ...process } }),
      files:
        diff.length > 0
          ? unifiedFiles(id, diff, failed)
          : tool.files.map((file) => ({ ...file, preview: false, status: failed ? "failed" : "complete" })),
    }
  })
  if (updated !== undefined) {
    if (
      requested?.presentation.rowDisplay !== "continuation" ||
      requested.parentId === undefined ||
      process?.running === undefined ||
      process.processId === undefined
    )
      return
    const parentTool = toolAt(value, requested.parentId)
    if (parentTool?.status !== "running" || parentTool.process?.processId !== process.processId) return
    const running = process.running
    const processId = process.processId
    updateTool(value, change, requested.parentId, event.sequence, (tool) => {
      let status: Extract<Block, { _tag: "ToolCall" }>["status"] = "complete"
      if (process.exitCode !== undefined && process.exitCode !== 0) status = "failed"
      else if (running) status = "running"
      const mergedOutput = foldOutput(
        initialProcessOutput(tool),
        resultText,
        Catalog.get(tool.name)?.outputLimit ?? 40_000,
      )
      return {
        ...tool,
        status,
        ...(mergedOutput.output === undefined ? {} : { output: mergedOutput.output }),
        process: {
          ...tool.process,
          processId,
          running,
          ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
          truncated: tool.process?.truncated === true || process.truncated === true || mergedOutput.truncated,
        },
      }
    })
    return
  }
  const block: Block = { _tag: "ToolResult", id, output: resultText, failed }
  upsertUnit(
    value,
    change,
    makeUnit(identityKey("tool-result", turnId, rawId), turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const applyToolProgress = ({
  value,
  change,
  turnId,
  event,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly turnId: string
  readonly event: SourceEvent
}): void => {
  const rawId = rawToolId(event)
  const id = scopedIdentity(turnId, rawId)
  const message = event.text ?? ""
  if (message.length === 0) return
  updateTool(value, change, id, event.sequence, (tool) => ({
    ...tool,
    output: tool.output === undefined || tool.output.length === 0 ? message : `${tool.output}\n${message}`,
  }))
}

export { applyToolDelta, applyToolProgress, applyToolRequested, applyToolResult, toolBlock }
