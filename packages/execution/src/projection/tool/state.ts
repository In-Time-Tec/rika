import { Catalog } from "@rika/product/native-tool-catalog"
import { Function, Option, Schema } from "effect"
import type { Block } from "@rika/product/execution-transcript-contract"

type Tool = Extract<Block, { readonly _tag: "ToolCall" }>
type ToolFile = Tool["files"][number]

const ToolInput = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  file_path: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  read_range: Schema.optionalKey(Schema.Tuple([Schema.Finite, Schema.Finite])),
  offset: Schema.optionalKey(Schema.Finite),
  limit: Schema.optionalKey(Schema.Finite),
  pattern: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  cmd: Schema.optionalKey(Schema.String),
  script: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  workdir: Schema.optionalKey(Schema.String),
  timeout_ms: Schema.optionalKey(Schema.Finite),
  waitMillis: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  wait_millis: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  processId: Schema.optionalKey(Schema.String),
  process_id: Schema.optionalKey(Schema.String),
  objective: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  task: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  old_str: Schema.optionalKey(Schema.String),
  oldText: Schema.optionalKey(Schema.String),
  new_str: Schema.optionalKey(Schema.String),
  newText: Schema.optionalKey(Schema.String),
})
type ToolInput = typeof ToolInput.Type

const ToolOutput = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  elapsedMillis: Schema.optionalKey(Schema.Finite),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
  diff: Schema.optionalKey(Schema.String),
})

const emptyInput = ToolInput.make({})
const emptyOutput = ToolOutput.make({})
const inputRecord = (input: string): ToolInput => {
  const decoded = Schema.decodeOption(Schema.fromJsonString(ToolInput))(input)
  return Option.isSome(decoded) ? decoded.value : emptyInput
}
const field = (input: ToolInput, names: ReadonlyArray<keyof ToolInput>): string | undefined => {
  for (const name of names) {
    const value = input[name]
    if (Schema.is(Schema.String)(value) && value.length > 0) return value
  }
  return undefined
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
const namedDetail = (name: string, input: ToolInput, path: string | undefined): string | undefined => {
  switch (name) {
    case "grep":
      return `${path === undefined ? "" : `${path} `}"${field(input, ["pattern"]) ?? ""}"`.trim()
    case "bash":
      return [field(input, ["command", "cmd", "script"]) ?? "", ...(input.args ?? [])].join(" ").trim()
    case "shell_command_status":
      return field(input, ["processId", "process_id"]) ?? ""
    case "web_search":
      return field(input, ["objective", "query"]) ?? ""
    case "read_web_page":
      return field(input, ["url"]) ?? ""
    default:
      return undefined
  }
}
const detail = (name: string, encodedInput: string): string => {
  const input = inputRecord(encodedInput)
  const normalized = name.toLowerCase()
  const path = field(input, ["path", "file_path", "file"])
  if (normalized === "read") {
    const range = input.read_range
    if (range !== undefined) return `${path ?? name} L${range[0]}-${range[1]}`
    const offset = input.offset ?? 1
    const limit = input.limit
    return `${path ?? name}${limit === undefined ? "" : ` L${offset}-${offset + Math.max(0, limit - 1)}`}`
  }
  const named = namedDetail(normalized, input, path)
  if (named !== undefined) return named
  if (path !== undefined) return path
  return field(input, ["description", "prompt", "task", "query", "objective"]) ?? ""
}
const files = (id: string, name: string, encodedInput: string): ReadonlyArray<ToolFile> => {
  const input = inputRecord(encodedInput)
  const path = field(input, ["path", "file_path", "file"])
  if (path === undefined || (name !== "write" && name !== "edit")) return []
  const oldText = input.old_str ?? input.oldText ?? ""
  const newText = input.new_str ?? input.newText ?? ""
  const patch =
    name === "write"
      ? `--- /dev/null\n+++ b/${path}\n${(input.content ?? "")
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      : `--- a/${path}\n+++ b/${path}\n${oldText
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${newText
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

const processCheckFromInput = (toolCallId: string, encodedInput: string) => {
  const input = inputRecord(encodedInput)
  const processId = field(input, ["processId", "process_id"])
  if (processId === undefined) return undefined
  const wait = input.waitMillis ?? input.wait_millis
  return wait == null ? { toolCallId, processId } : { toolCallId, processId, waitMillis: wait }
}

const initialProcess = (name: string, input: ToolInput): Tool["process"] => {
  const command = field(input, ["command", "cmd", "script"])
  if (name.toLowerCase() !== "bash" || command === undefined) return undefined
  const process: NonNullable<Tool["process"]> = { command }
  if (input.workdir !== undefined) Object.assign(process, { workdir: input.workdir })
  if (input.timeout_ms === 0) Object.assign(process, { background: true })
  return process
}

const restorePrevious = (base: Tool, process: Tool["process"], previous?: Tool): Tool => {
  if (previous === undefined) return base
  let tool = base
  if (previous.result !== undefined) tool = { ...tool, result: previous.result }
  if (previous.process !== undefined) tool = { ...tool, process: { ...process, ...previous.process } }
  if (previous.operationId !== undefined) tool = { ...tool, operationId: previous.operationId }
  if (previous.truncated !== undefined) tool = { ...tool, truncated: previous.truncated }
  if (previous.parentId !== undefined) tool = { ...tool, parentId: previous.parentId }
  return tool
}

const makeToolImpl = (id: string, rawId: string, name: string, input: string, previous?: Tool): Tool => {
  const decodedInput = inputRecord(input)
  const process = initialProcess(name, decodedInput)
  let tool: Tool = {
    _tag: "ToolCall",
    id,
    name,
    input,
    toolCallId: previous?.toolCallId ?? rawId,
    status: previous?.status ?? "running",
    presentation:
      previous === undefined || previous.name !== name ? Catalog.resolvePresentation(name) : previous.presentation,
    detail: detail(name, input),
    files: files(id, name, input),
  }
  if (name.toLowerCase() === "read" && decodedInput.read_range !== undefined)
    tool = { ...tool, readRange: decodedInput.read_range }
  if (process !== undefined) tool = { ...tool, process }
  return restorePrevious(tool, process, previous)
}

const processFrom = (value: typeof ToolOutput.Type): NonNullable<Tool["process"]> => {
  const { status: _status, diff: _diff, ...process } = value
  return process
}

const completionStatus = (statusText: string, process: NonNullable<Tool["process"]>, isFailure: boolean) => {
  const failed = isFailure || statusText === "failed" || (process.exitCode !== undefined && process.exitCode !== 0)
  if (statusText === "rejected") return { tool: "rejected", file: "failed" } as const
  if (failed) return { tool: "failed", file: "failed" } as const
  if (statusText === "cancelled" || statusText === "canceled") return { tool: "cancelled", file: "complete" } as const
  if (process.running === true) return { tool: "running", file: "running" } as const
  return { tool: "complete", file: "complete" } as const
}

const completeToolImpl = <Output>(tool: Tool, output: Output, isFailure: boolean): Tool => {
  const decoded = Schema.decodeUnknownOption(ToolOutput)(output)
  const value = Option.isSome(decoded) ? decoded.value : emptyOutput
  const statusText = (value.status ?? "").toLowerCase()
  const process = processFrom(value)
  const status = completionStatus(statusText, process, isFailure)
  const resolved = value.diff ?? ""
  const json = Schema.decodeUnknownOption(Schema.Json)(output)
  const result: Schema.Json = Option.isSome(json) ? json.value : String(output)
  let completed: Tool = {
    ...tool,
    status: status.tool,
    result,
    files: tool.files.map((file, index) => {
      const applied = index === 0 && resolved.length > 0 ? { patch: resolved, ...lineCounts(resolved) } : {}
      return { ...file, ...applied, preview: false, status: status.file }
    }),
  }
  const { stderr, stdout } = process
  const hasProcess =
    tool.process !== undefined ||
    process.running !== undefined ||
    process.processId !== undefined ||
    process.exitCode !== undefined ||
    process.elapsedMillis !== undefined ||
    stdout !== undefined ||
    stderr !== undefined
  if (hasProcess) {
    const mergedProcess = { ...tool.process, ...process }
    if (tool.name === "bash" && process.running === true) Object.assign(mergedProcess, { background: true })
    completed = { ...completed, process: mergedProcess }
  }
  if (value.truncated !== undefined) completed = { ...completed, truncated: value.truncated }
  return completed
}

export const makeTool: {
  (
    arg0: Parameters<typeof makeToolImpl>[0],
    arg1: Parameters<typeof makeToolImpl>[1],
    arg2: Parameters<typeof makeToolImpl>[2],
    arg3: Parameters<typeof makeToolImpl>[3],
    arg4: Parameters<typeof makeToolImpl>[4],
  ): ReturnType<typeof makeToolImpl>
  (
    arg1: Parameters<typeof makeToolImpl>[1],
    arg2: Parameters<typeof makeToolImpl>[2],
    arg3: Parameters<typeof makeToolImpl>[3],
    arg4: Parameters<typeof makeToolImpl>[4],
  ): (arg0: Parameters<typeof makeToolImpl>[0]) => ReturnType<typeof makeToolImpl>
} = Function.dual((args) => args.length >= 4, makeToolImpl)

export const Input = { processCheckFromInput }

export const completeTool: {
  (
    arg0: Parameters<typeof completeToolImpl>[0],
    arg1: Parameters<typeof completeToolImpl>[1],
    arg2: Parameters<typeof completeToolImpl>[2],
  ): ReturnType<typeof completeToolImpl>
  (
    arg1: Parameters<typeof completeToolImpl>[1],
    arg2: Parameters<typeof completeToolImpl>[2],
  ): (arg0: Parameters<typeof completeToolImpl>[0]) => ReturnType<typeof completeToolImpl>
} = Function.dual(3, completeToolImpl)
