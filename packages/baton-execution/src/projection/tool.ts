import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import { Function, Option, Schema } from "effect"
import type { Block } from "@rika/product/execution-transcript-contract"

type Tool = Extract<Block, { readonly _tag: "ToolCall" }>
type ToolFile = Tool["files"][number]

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {}
const optionalString = (value: unknown): string => (typeof value === "string" ? value : "")
const inputRecord = (input: string): Readonly<Record<string, unknown>> => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(input)
  return Option.isSome(decoded) ? record(decoded.value) : {}
}
const field = (input: Readonly<Record<string, unknown>>, names: ReadonlyArray<string>): string | undefined => {
  for (const name of names) if (typeof input[name] === "string" && input[name].length > 0) return input[name]
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
const detail = (name: string, encodedInput: string): string => {
  const input = inputRecord(encodedInput)
  const normalized = name.toLowerCase()
  const path = field(input, ["path", "file_path", "file"])
  if (normalized === "read") {
    const range = Array.isArray(input.read_range) ? input.read_range : undefined
    if (typeof range?.[0] === "number" && typeof range[1] === "number")
      return `${path ?? name} L${range[0]}-${range[1]}`
    const offset = typeof input.offset === "number" ? input.offset : 1
    const limit = typeof input.limit === "number" ? input.limit : undefined
    return `${path ?? name}${limit === undefined ? "" : ` L${offset}-${offset + Math.max(0, limit - 1)}`}`
  }
  if (normalized === "grep") return `${path === undefined ? "" : `${path} `}"${field(input, ["pattern"]) ?? ""}"`.trim()
  if (normalized === "bash") {
    const command = field(input, ["command", "cmd", "script"]) ?? ""
    const args = Array.isArray(input.args)
      ? input.args.filter((value): value is string => typeof value === "string")
      : []
    return [command, ...args].join(" ").trim()
  }
  if (normalized === "shell_command_status") return field(input, ["processId", "process_id"]) ?? ""
  if (normalized === "web_search") return field(input, ["objective", "query"]) ?? ""
  if (normalized === "read_web_page") return field(input, ["url"]) ?? ""
  if (path !== undefined) return path
  return field(input, ["description", "prompt", "task", "query", "objective"]) ?? ""
}
const files = (id: string, name: string, encodedInput: string): ReadonlyArray<ToolFile> => {
  const input = inputRecord(encodedInput)
  const path = field(input, ["path", "file_path", "file"])
  if (path === undefined || (name !== "write" && name !== "edit")) return []
  const patch =
    name === "write"
      ? `--- /dev/null\n+++ b/${path}\n${optionalString(input.content)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      : `--- a/${path}\n+++ b/${path}\n${optionalString(input.old_str ?? input.oldText)
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${optionalString(input.new_str ?? input.newText)
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

const makeToolImpl = (id: string, name: string, input: string, previous?: Tool): Tool => ({
  _tag: "ToolCall",
  id,
  name,
  input,
  status: previous?.status ?? "running",
  presentation:
    previous === undefined || previous.name !== name ? Catalog.resolvePresentation(name) : previous.presentation,
  detail: detail(name, input),
  files: files(id, name, input),
  ...(previous?.output === undefined ? {} : { output: previous.output }),
  ...(previous?.process === undefined ? {} : { process: previous.process }),
  ...(previous?.parentId === undefined ? {} : { parentId: previous.parentId }),
})

const completeToolImpl = (tool: Tool, output: unknown, isFailure: boolean, encodedOutput: string): Tool => {
  const value = record(output)
  const statusText = optionalString(value.status).toLowerCase()
  const process = {
    ...(typeof value.running === "boolean" ? { running: value.running } : {}),
    ...(typeof value.processId === "string" ? { processId: value.processId } : {}),
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(typeof value.stdout === "string" ? { stdout: value.stdout } : {}),
    ...(typeof value.stderr === "string" ? { stderr: value.stderr } : {}),
    ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
  }
  const failed = isFailure || statusText === "failed" || (process.exitCode !== undefined && process.exitCode !== 0)
  const cancelled = statusText === "cancelled" || statusText === "canceled"
  const running = process.running === true
  let completionStatus: Tool["status"] = "complete"
  if (running) completionStatus = "running"
  if (cancelled) completionStatus = "cancelled"
  if (failed) completionStatus = "failed"
  let fileStatus: ToolFile["status"] = "complete"
  if (running) fileStatus = "running"
  if (failed) fileStatus = "failed"
  const resolved = optionalString(value.diff)
  return {
    ...tool,
    status: completionStatus,
    output: encodedOutput,
    ...(Object.keys(process).length === 0 ? {} : { process }),
    files: tool.files.map((file, index) => {
      const applied = index === 0 && resolved.length > 0 ? { patch: resolved, ...lineCounts(resolved) } : {}
      return { ...file, ...applied, preview: false, status: fileStatus }
    }),
  }
}

export const makeTool: {
  (
    arg0: Parameters<typeof makeToolImpl>[0],
    arg1: Parameters<typeof makeToolImpl>[1],
    arg2: Parameters<typeof makeToolImpl>[2],
    arg3: Parameters<typeof makeToolImpl>[3],
  ): ReturnType<typeof makeToolImpl>
  (
    arg1: Parameters<typeof makeToolImpl>[1],
    arg2: Parameters<typeof makeToolImpl>[2],
    arg3: Parameters<typeof makeToolImpl>[3],
  ): (arg0: Parameters<typeof makeToolImpl>[0]) => ReturnType<typeof makeToolImpl>
} = Function.dual((args) => args.length >= 3, makeToolImpl)

export const completeTool: {
  (
    arg0: Parameters<typeof completeToolImpl>[0],
    arg1: Parameters<typeof completeToolImpl>[1],
    arg2: Parameters<typeof completeToolImpl>[2],
    arg3: Parameters<typeof completeToolImpl>[3],
  ): ReturnType<typeof completeToolImpl>
  (
    arg1: Parameters<typeof completeToolImpl>[1],
    arg2: Parameters<typeof completeToolImpl>[2],
    arg3: Parameters<typeof completeToolImpl>[3],
  ): (arg0: Parameters<typeof completeToolImpl>[0]) => ReturnType<typeof completeToolImpl>
} = Function.dual(4, completeToolImpl)
