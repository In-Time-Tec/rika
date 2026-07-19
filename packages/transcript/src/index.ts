import { Catalog } from "@rika/tools"
import { Function, Option, Schema } from "effect"
import type { Block, Content, Projection, SourceEvent, ToolFile, ToolProcess, Unit } from "./schema"

export * from "./schema"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const string = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)

const sourcePayload = (event: SourceEvent): Record<string, unknown> => event.data ?? record(event.content?.[0])

const callPayload = (event: SourceEvent): Record<string, unknown> => {
  const value = sourcePayload(event)
  return value.type === "tool-call" ? record(value.call) : value
}

const resultPayload = (event: SourceEvent): Record<string, unknown> => {
  const value = sourcePayload(event)
  return value.type === "tool-result" ? record(value.result) : value
}

const encodeInput = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? {}))

const outputText = (output: unknown): string => {
  if (typeof output === "string") return output
  const value = record(output)
  if (typeof value.text === "string") return value.text
  return JSON.stringify(output)
}

const eventId = (turnId: string, id: string): string => (turnId.length === 0 ? id : `${turnId}:${id}`)

const executionKey = (value: string): string => value.replace(/^execution:/, "")

const rawToolId = (event: SourceEvent): string => {
  const value = event.type === "tool.result.received" ? resultPayload(event) : callPayload(event)
  return string(value.tool_call_id ?? value.call_id ?? value.callId ?? value.id, event.cursor)
}

const toolKey = (turnId: string, id: string): string => `tool:${eventId(turnId, id)}`

const unit = (
  key: string,
  turnId: string,
  sequence: number,
  part: number,
  revision: number,
  content: Content,
): Unit => ({ key, turnId, order: { sequence, part }, revision, content })

const replaceUnit = (projection: Projection, index: number, next: Unit): Projection => {
  const units = [...projection.units]
  units[index] = next
  return { ...projection, units }
}

const applyExecutionOutcome = (
  projection: Projection,
  turnId: string,
  revision: number,
  outcome: NonNullable<Unit["executionOutcome"]>,
): Projection => {
  const index = projection.units.findIndex(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.parentId === undefined &&
      candidate.content._tag === "Entry" &&
      candidate.content.role === "user",
  )
  if (index >= 0)
    return replaceUnit(projection, index, { ...projection.units[index]!, revision, executionOutcome: outcome })
  return upsertUnit(projection, {
    ...unit(`execution:${turnId}:outcome`, turnId, Number.MAX_SAFE_INTEGER, 0, revision, {
      _tag: "Entry",
      role: "notice",
      text: "",
    }),
    executionOutcome: outcome,
  })
}

const upsertUnit = (projection: Projection, incoming: Unit): Projection => {
  const index = projection.units.findIndex((candidate) => candidate.key === incoming.key)
  if (index < 0) return { ...projection, units: [...projection.units, incoming] }
  return replaceUnit(projection, index, { ...incoming, order: projection.units[index]!.order })
}

const partialJsonString = (raw: string, keys: ReadonlyArray<string>): string | undefined => {
  const keyPattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const match = new RegExp(`"(?:${keyPattern})"\\s*:\\s*"`).exec(raw)
  if (match === null) return undefined
  let index = match.index + match[0].length
  let value = ""
  while (index < raw.length) {
    const character = raw[index]!
    if (character === '"') return value
    if (character !== "\\") {
      value += character
      index += 1
      continue
    }
    if (index + 1 >= raw.length) return value
    const escaped = raw[index + 1]!
    if (escaped === "u") {
      const hex = raw.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return value
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 6
      continue
    }
    value +=
      escaped === "n"
        ? "\n"
        : escaped === "r"
          ? "\r"
          : escaped === "t"
            ? "\t"
            : escaped === "b"
              ? "\b"
              : escaped === "f"
                ? "\f"
                : escaped
    index += 2
  }
  return value
}

const lineCounts = (patch: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

const previewFiles = (callId: string, patch: string): ReadonlyArray<ToolFile> => {
  const matches = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
  return matches.map((match, ordinal) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[ordinal + 1]?.index ?? patch.length
    const body = patch
      .slice(start, end)
      .replace(/^\n/, "")
      .replace(/\n?\*\*\* End Patch[\s\S]*$/, "")
    const move = /^\*\*\* Move to: (.+)$/m.exec(body)?.[1]
    const kind: ToolFile["kind"] =
      match[1] === "Add" ? "add" : match[1] === "Delete" ? "delete" : move === undefined ? "update" : "move"
    const path = move ?? match[2]!
    const diffBody = body
      .split("\n")
      .filter((line) => line.startsWith("@@") || /^[ +-]/u.test(line))
      .join("\n")
    const rendered =
      kind === "delete"
        ? `--- a/${match[2]}\n+++ /dev/null\n${diffBody}`
        : `--- ${kind === "add" ? "/dev/null" : `a/${match[2]}`}\n+++ b/${path}\n${diffBody}`
    const counts = lineCounts(rendered)
    const file = {
      key: `${callId}:${ordinal}`,
      path,
      kind,
      patch: rendered,
      additions: counts.additions,
      deletions: counts.deletions,
      preview: true,
      status: "running" as const,
    }
    return move === undefined ? file : Object.assign(file, { previousPath: match[2]! })
  })
}

const normalizedDiffPath = (value: string): string => value.replace(/^(?:a|b)\//, "")

const unifiedFiles = (callId: string, diff: string, failed: boolean): ReadonlyArray<ToolFile> => {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0)
  const ranges = starts.length === 0 ? [0] : starts
  return ranges.flatMap((start, ordinal) => {
    const end = ranges[ordinal + 1] ?? diff.length
    const patch = diff.slice(start, end).trimEnd()
    const oldPath = /^--- (.+)$/m.exec(patch)?.[1]
    const newPath = /^\+\+\+ (.+)$/m.exec(patch)?.[1]
    if (oldPath === undefined && newPath === undefined) return []
    const created = oldPath === "/dev/null" || /new file mode/m.test(patch)
    const deleted = newPath === "/dev/null" || /deleted file mode/m.test(patch)
    const path = normalizedDiffPath(deleted ? oldPath! : newPath!)
    const previousPath = oldPath === undefined || oldPath === "/dev/null" ? undefined : normalizedDiffPath(oldPath)
    const kind = created ? "add" : deleted ? "delete" : previousPath !== path ? "move" : "update"
    return [
      {
        key: `${callId}:${ordinal}`,
        path,
        kind,
        patch,
        ...lineCounts(patch),
        preview: false,
        status: failed ? "failed" : "complete",
        ...(kind === "move" && previousPath !== undefined ? { previousPath } : {}),
      } satisfies ToolFile,
    ]
  })
}

const inputRecord = (input: string): Record<string, unknown> => {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input)
  if (Option.isNone(decoded)) return {}
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
  if (normalizedName === "read_file" || normalizedName === "read") {
    const offset = typeof input.offset === "number" ? input.offset : 1
    const limit = typeof input.limit === "number" ? input.limit : undefined
    return `${path ?? name}${limit === undefined ? "" : ` L${offset}-${offset + Math.max(0, limit - 1)}`}`
  }
  if (normalizedName === "grep")
    return `${path === undefined ? "" : `${path} `}"${inputString(input, ["pattern"]) ?? ""}"`.trim()
  if (normalizedName === "find_files") return `"${inputString(input, ["query"]) ?? ""}"`
  if (normalizedName === "git_status") return "git status"
  if (normalizedName === "shell") {
    const command = inputString(input, ["command", "cmd", "script"]) ?? ""
    const args = Array.isArray(input.args)
      ? input.args.filter((value): value is string => typeof value === "string")
      : []
    return [command, ...args].join(" ").trim()
  }
  if (normalizedName === "shell_command_status") return inputString(input, ["processId", "process_id"]) ?? ""
  if (normalizedName === "web_search") return inputString(input, ["objective", "query"]) ?? ""
  if (normalizedName === "read_web_page") return inputString(input, ["url"]) ?? ""
  if (normalizedName === "find_thread") return inputString(input, ["query"]) ?? ""
  if (normalizedName === "read_thread") return inputString(input, ["threadId", "thread_id", "id"]) ?? ""
  if (normalizedName === "apply_patch") return ""
  if (path !== undefined) return path
  return inputString(input, ["description", "prompt", "task", "query", "objective"]) ?? inputContentText(input) ?? ""
}

const inputFiles = (id: string, name: string, inputText: string): ReadonlyArray<ToolFile> => {
  const input = inputRecord(inputText)
  if (name === "apply_patch") return previewFiles(id, inputString(input, ["patchText", "patch"]) ?? "")
  const path = inputString(input, ["path", "file_path", "file"])
  if (path === undefined || (name !== "create_file" && name !== "edit_file")) return []
  const patch =
    name === "create_file"
      ? `--- /dev/null\n+++ b/${path}\n${string(input.content)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      : `--- a/${path}\n+++ b/${path}\n${string(input.oldText)
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${string(input.newText)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
  return [
    {
      key: `${id}:0`,
      path,
      kind: name === "create_file" ? "add" : "update",
      patch,
      ...lineCounts(patch),
      preview: true,
      status: "running",
    },
  ]
}

const toolBlock = (id: string, name: string, input: string, previous?: Extract<Block, { _tag: "ToolCall" }>) => ({
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

const toolIndex = (projection: Projection, id: string): number =>
  projection.units.findIndex(
    (candidate) =>
      candidate.content._tag === "Block" &&
      candidate.content.block._tag === "ToolCall" &&
      candidate.content.block.id === id,
  )

const toolAt = (projection: Projection, id: string): Extract<Block, { _tag: "ToolCall" }> | undefined => {
  const index = toolIndex(projection, id)
  const content = index < 0 ? undefined : projection.units[index]?.content
  return content?._tag === "Block" && content.block._tag === "ToolCall" ? content.block : undefined
}

const childToolAt = (projection: Projection, childId: string): Extract<Block, { _tag: "ToolCall" }> | undefined =>
  projection.units
    .map((candidate) => (candidate.content._tag === "Block" ? candidate.content.block : undefined))
    .find(
      (block): block is Extract<Block, { readonly _tag: "ToolCall" }> =>
        block?._tag === "ToolCall" &&
        block.childId !== undefined &&
        executionKey(block.childId) === executionKey(childId),
    )

const childToolCallId = (childId: string): string | undefined => {
  const marker = ":child:"
  const index = childId.lastIndexOf(marker)
  return index < 0 ? undefined : childId.slice(index + marker.length)
}

const updateTool = (
  projection: Projection,
  id: string,
  sequence: number,
  update: (tool: Extract<Block, { _tag: "ToolCall" }>) => Extract<Block, { _tag: "ToolCall" }>,
): Projection => {
  const index = toolIndex(projection, id)
  const current = index < 0 ? undefined : projection.units[index]
  if (current?.content._tag !== "Block" || current.content.block._tag !== "ToolCall") return projection
  return replaceUnit(projection, index, {
    ...current,
    revision: sequence,
    content: { _tag: "Block", block: update(current.content.block) },
  })
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

const nonNegativeFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const usageCost = (value: Record<string, unknown>): number | undefined => {
  for (const key of ["cost_usd", "costUsd"]) {
    const candidate = nonNegativeFinite(value[key])
    if (candidate !== undefined) return candidate
  }
  return undefined
}

const assistantKey = (turnId: string, phase: number): string => `assistant:${turnId}:${Math.max(0, phase)}`
const reasoningKey = (turnId: string, phase: number): string => `reasoning:${turnId}:${Math.max(0, phase)}`

const assistantText = (event: SourceEvent): string => event.text ?? string(sourcePayload(event).text)

const applyAssistant = (projection: Projection, turnId: string, event: SourceEvent, complete: boolean): Projection => {
  const key = assistantKey(turnId, projection.modelPhase)
  const index = projection.units.findIndex((candidate) => candidate.key === key)
  const current = index < 0 ? undefined : projection.units[index]
  const text = assistantText(event)
  const aggregateCompletion = complete && typeof sourcePayload(event).model_output === "string"
  if (aggregateCompletion) {
    const hasAssistant = projection.units.some(
      (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
    )
    if (hasAssistant)
      return current?.content._tag === "Entry" && current.content.role === "assistant"
        ? replaceUnit(projection, index, { ...current, revision: event.sequence })
        : projection
  }
  if (current?.content._tag === "Entry" && current.content.role === "assistant")
    return replaceUnit(projection, index, {
      ...current,
      revision: event.sequence,
      content: {
        ...current.content,
        text: complete && text.length > 0 ? text : current.content.text + text,
      },
    })
  if (text.length === 0) return projection
  return upsertUnit(
    projection,
    unit(key, turnId, event.sequence, 0, event.sequence, { _tag: "Entry", role: "assistant", text }),
  )
}

const childStatus = (
  event: SourceEvent,
  value: Record<string, unknown>,
): "running" | "complete" | "failed" | "cancelled" => {
  const raw = string(value.status ?? value.state).toLowerCase()
  if (raw === "failed" || raw === "error") return "failed"
  if (raw === "cancelled" || raw === "canceled") return "cancelled"
  if (raw === "completed" || raw === "complete" || raw === "succeeded" || raw === "terminal") return "complete"
  if (event.type.includes("failed")) return "failed"
  if (event.type.includes("cancel")) return "cancelled"
  if (event.type.includes("terminal") || event.type.includes("completed")) return "complete"
  return "running"
}

const applyChild = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const outer = sourcePayload(event)
  const value = Object.keys(record(outer.member)).length > 0 ? record(outer.member) : outer
  const childId = string(
    value.child_execution_id ??
      value.child_run_id ??
      value.childId ??
      value.child_id ??
      outer.child_execution_id ??
      outer.child_run_id ??
      outer.childId,
    event.cursor,
  )
  const correlatedToolId = string(value.tool_call_id ?? value.parent_tool_call_id)
  const encodedToolId = childToolCallId(childId)
  const linkedTool =
    correlatedToolId.length > 0
      ? toolAt(projection, eventId(turnId, correlatedToolId))
      : (childToolAt(projection, childId) ??
        (encodedToolId === undefined ? undefined : toolAt(projection, eventId(turnId, encodedToolId))))
  if (linkedTool !== undefined) {
    const id = linkedTool.id
    const childState = childStatus(event, value)
    const profile = string(value.profile ?? value.preset_name ?? value.name).toLowerCase()
    const presentation =
      profile.length === 0
        ? linkedTool.presentation
        : Catalog.resolvePresentation(
            profile === "task" || profile === "child" || profile === "subagent"
              ? "task"
              : profile === "oracle" || profile === "librarian"
                ? profile
                : `transfer_to_${profile}`,
          )
    const updated = updateTool(projection, id, event.sequence, (tool) => ({
      ...tool,
      childId,
      status: childState,
      presentation,
      ...(string(value.summary ?? value.output ?? value.error).length === 0
        ? {}
        : { output: string(value.summary ?? value.output ?? value.error) }),
    }))
    if (updated !== projection)
      return {
        ...updated,
        units: updated.units.filter((candidate) => {
          const block = candidate.content._tag === "Block" ? candidate.content.block : undefined
          return block?._tag !== "ChildAgent" || executionKey(block.id) !== executionKey(childId)
        }),
      }
  }
  const key = `child:${eventId(turnId, childId)}`
  const current = projection.units.find((candidate) => candidate.key === key)
  const previous =
    current?.content._tag === "Block" && current.content.block._tag === "ChildAgent" ? current.content.block : undefined
  const activity = string(value.activity ?? value.event ?? value.detail ?? event.text)
  const block: Extract<Block, { _tag: "ChildAgent" }> = {
    _tag: "ChildAgent",
    id: childId,
    name: string(value.profile ?? value.preset_name ?? value.name, previous?.name ?? "child"),
    summary: string(value.summary ?? value.output ?? value.error, previous?.summary ?? ""),
    status: childStatus(event, value),
    activity: activity.length === 0 ? (previous?.activity ?? []) : [...(previous?.activity ?? []), activity],
  }
  return upsertUnit(
    projection,
    unit(key, turnId, current?.order.sequence ?? event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const genericBlock = (turnId: string, event: SourceEvent): Block | undefined => {
  const value = sourcePayload(event)
  if (event.type === "tool.approval.requested" || event.type === "tool.approval.resolved")
    return {
      _tag: "Permission",
      id: string(value.wait_id, event.cursor),
      kind: "tool-approval",
      title: string(value.tool_name, "Permission required"),
      detail: encodeInput(value.input),
      status: event.type === "tool.approval.requested" ? "pending" : value.approved === false ? "denied" : "approved",
    }
  if (event.type === "permission.ask.requested" || event.type === "permission.ask.resolved")
    return {
      _tag: "Permission",
      id: string(value.wait_id ?? value.permission_id, event.cursor),
      kind: "permission",
      title: string(value.title ?? value.tool_name ?? value.name, "Permission required"),
      detail: encodeInput(value.input),
      status: event.type === "permission.ask.requested" ? "pending" : value.approved === false ? "denied" : "approved",
    }
  if (event.type.includes("diff"))
    return { _tag: "Diff", path: string(value.path, "diff"), patch: event.text ?? string(value.patch ?? value.diff) }
  if (event.type.includes("compact"))
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary),
      ...(string(value.checkpoint ?? value.checkpoint_id).length === 0
        ? {}
        : { checkpoint: string(value.checkpoint ?? value.checkpoint_id) }),
    }
  if (event.type.includes("notification"))
    return {
      _tag: "Notification",
      title: string(value.title ?? value.name, "Notification"),
      detail: event.text ?? string(value.detail ?? value.message),
    }
  if (event.type.includes("image") && event.type.includes("attachment"))
    return {
      _tag: "ImageAttachment",
      name: string(value.name ?? value.filename, "image"),
      mediaType: string(value.media_type ?? value.mediaType, "application/octet-stream"),
      ...(typeof value.width === "number" ? { width: value.width } : {}),
      ...(typeof value.height === "number" ? { height: value.height } : {}),
      ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    }
  if (event.type.includes("workflow"))
    return {
      _tag: "Workflow",
      name: string(value.workflow ?? value.name, "workflow"),
      step: event.text ?? string(value.step ?? value.status),
      status: event.type.includes("failed")
        ? "failed"
        : event.type.includes("completed")
          ? "complete"
          : event.type.includes("wait")
            ? "waiting"
            : "running",
    }
  if (event.type.includes("error") || event.type.includes("failed") || event.type === "budget.exceeded")
    return {
      _tag: "Error",
      title: string(value.title, event.type === "budget.exceeded" ? "Budget exceeded" : "Error"),
      detail: event.text ?? string(value.message ?? value.error, event.type),
      turnId,
      ...(string(value.recovery).length === 0 ? {} : { recovery: string(value.recovery) }),
    }
  if (event.type.includes("tool") && (event.type.includes("result") || event.type.includes("completed")))
    return {
      _tag: "ToolResult",
      id: eventId(turnId, string(value.callId ?? value.call_id ?? value.id, event.cursor)),
      output: event.text ?? string(value.output ?? value.result),
      failed: event.type.includes("failed") || value.failed === true,
    }
  if (event.type.includes("tool")) {
    const id = eventId(turnId, string(value.callId ?? value.call_id ?? value.id, event.cursor))
    const name = string(value.name ?? value.tool, "tool")
    const input = encodeInput(value.input ?? value)
    return toolBlock(id, name, input)
  }
  return undefined
}

const genericKey = (turnId: string, event: SourceEvent, block: Block): string => {
  const value = sourcePayload(event)
  switch (block._tag) {
    case "Diff":
      return `diff:${eventId(turnId, block.path)}`
    case "Compaction":
      return `compaction:${turnId}`
    case "Permission":
      return `permission:${eventId(turnId, block.id)}`
    case "ChildAgent":
      return `child:${eventId(turnId, block.id)}`
    case "Workflow":
      return `workflow:${eventId(turnId, string(value.run_id ?? value.runId ?? value.workflow_id, block.name))}`
    case "ImageAttachment":
      return `image:${eventId(turnId, string(value.id, block.name))}`
    case "Notification":
      return `notification:${eventId(turnId, string(value.id, block.title))}`
    case "Error":
      return `error:${eventId(turnId, string(value.id, event.type))}`
    default: {
      const id = "id" in block && typeof block.id === "string" ? block.id : `${event.sequence}:${event.type}`
      return `event:${eventId(turnId, id)}`
    }
  }
}

export const empty: {
  (turnId: string, prompt: string): Projection
  (prompt: string): (turnId: string) => Projection
} = Function.dual(
  2,
  (turnId: string, prompt: string): Projection => ({
    units: [unit(`turn:${turnId}:user`, turnId, -1, 0, 0, { _tag: "Entry", role: "user", text: prompt })],
    revision: -1,
    modelPhase: -1,
  }),
)

const applyToolDelta = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const value = callPayload(event)
  const rawId = rawToolId(event)
  const id = eventId(turnId, rawId)
  const previous = toolAt(projection, id)
  const delta = string(value.delta ?? event.text)
  const input = `${previous?.input ?? ""}${delta}`
  const name = string(value.tool_name ?? value.name, previous?.name ?? "tool")
  const decodedPatch = name === "apply_patch" ? partialJsonString(input, ["patchText", "patch"]) : undefined
  const base = toolBlock(id, name, input, previous)
  const block = decodedPatch === undefined ? base : { ...base, files: previewFiles(id, decodedPatch) }
  return upsertUnit(
    projection,
    unit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const applyToolRequested = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const value = callPayload(event)
  const rawId = rawToolId(event)
  const id = eventId(turnId, rawId)
  const name = string(value.tool_name ?? value.name, toolAt(projection, id)?.name ?? "tool")
  const input = encodeInput(value.input)
  const previous = toolAt(projection, id)
  const base = toolBlock(id, name, input, previous)
  const processId =
    name === "shell_command_status" ? inputString(inputRecord(input), ["processId", "process_id"]) : undefined
  const parent =
    processId === undefined
      ? undefined
      : projection.units.find((candidate) => {
          if (candidate.content._tag !== "Block" || candidate.content.block._tag !== "ToolCall") return false
          return candidate.content.block.name === "shell" && candidate.content.block.process?.processId === processId
        })
  const block =
    parent?.content._tag === "Block" && parent.content.block._tag === "ToolCall"
      ? { ...base, detail: parent.content.block.detail, parentId: parent.content.block.id }
      : base
  return upsertUnit(
    projection,
    unit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const applyToolResult = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const value = resultPayload(event)
  const id = eventId(turnId, rawToolId(event))
  const output = value.output
  const outputStatus = string(record(output).status).toLowerCase()
  const process = processResult(output)
  const failed =
    typeof value.error === "string" ||
    record(output)._tag === "ToolError" ||
    outputStatus === "failed" ||
    (process?.exitCode !== undefined && process.exitCode !== 0)
  const cancelled = outputStatus === "cancelled" || outputStatus === "canceled"
  const errorText = string(value.error, string(record(output).message))
  const resultText = failed && errorText.length > 0 ? errorText : outputText(output)
  const diff = string(record(output).diff)
  const updated = updateTool(projection, id, event.sequence, (tool) => ({
    ...tool,
    status: failed ? "failed" : cancelled ? "cancelled" : process?.running === true ? "running" : "complete",
    output: resultText,
    ...(process === undefined ? {} : { process: { ...tool.process, ...process } }),
    files:
      diff.length > 0
        ? unifiedFiles(id, diff, failed)
        : tool.files.map((file) => ({ ...file, preview: false, status: failed ? "failed" : "complete" })),
  }))
  if (updated !== projection) return updated
  const result: Block = { _tag: "ToolResult", id, output: resultText, failed }
  return upsertUnit(
    projection,
    unit(`tool-result:${id}`, turnId, event.sequence, 0, event.sequence, { _tag: "Block", block: result }),
  )
}

const applyReasoning = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const key = reasoningKey(turnId, projection.modelPhase)
  const current = projection.units.find((candidate) => candidate.key === key)
  const previous =
    current?.content._tag === "Block" && current.content.block._tag === "Reasoning" ? current.content.block.text : ""
  const block: Block = { _tag: "Reasoning", text: previous + (event.text ?? string(sourcePayload(event).text)) }
  return upsertUnit(
    projection,
    unit(key, turnId, current?.order.sequence ?? event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const advanceModelPhase = (projection: Projection, turnId: string): Projection => {
  const phase = Math.max(0, projection.modelPhase)
  const hasOutput = projection.units.some(
    (candidate) => candidate.key === assistantKey(turnId, phase) || candidate.key === reasoningKey(turnId, phase),
  )
  return hasOutput ? { ...projection, modelPhase: phase + 1 } : projection
}

const applyKnownEvent = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  if (event.type === "model.input.prepared") {
    if (projection.modelPhase < 0) {
      const advanced = advanceModelPhase({ ...projection, modelPhase: 0 }, turnId)
      return advanced.modelPhase === 0 ? { ...projection, modelPhase: 0 } : advanced
    }
    return advanceModelPhase(projection, turnId)
  }
  if (event.type === "model.output.delta") return applyAssistant(projection, turnId, event, false)
  if (event.type === "model.output.completed") return applyAssistant(projection, turnId, event, true)
  if (event.type.includes("reasoning")) return applyReasoning(projection, turnId, event)
  if (event.type === "model.toolcall.delta") return applyToolDelta(projection, turnId, event)
  if (event.type === "tool.call.requested")
    return advanceModelPhase(applyToolRequested(projection, turnId, event), turnId)
  if (event.type === "tool.result.received") return applyToolResult(projection, turnId, event)
  if (event.type === "model.usage.reported") {
    const cost = usageCost(sourcePayload(event))
    return cost === undefined ? projection : { ...projection, costUsd: (projection.costUsd ?? 0) + cost }
  }
  if (event.type === "execution.completed")
    return applyExecutionOutcome(projection, turnId, event.sequence, { status: "complete" })
  if (event.type === "execution.failed") {
    const reason = event.text ?? string(sourcePayload(event).message, "Execution failed")
    const block: Block = {
      _tag: "Error",
      title: "Execution failed",
      detail: reason,
      turnId,
      recovery: "Edit your prompt and press Enter to try again.",
    }
    return upsertUnit(projection, {
      ...unit(`execution:${turnId}:failed`, turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
      executionOutcome: { status: "failed", reason },
    })
  }
  if (event.type === "execution.cancelled") {
    const payload = sourcePayload(event)
    const reason = event.text ?? string(payload.reason, string(payload.message))
    return upsertUnit(projection, {
      ...unit(`execution:${turnId}:cancelled`, turnId, event.sequence, 0, event.sequence, {
        _tag: "Entry",
        role: "notice",
        text: reason.length > 0 ? reason : "cancelled",
      }),
      executionOutcome: { status: "cancelled", ...(reason.length > 0 ? { reason } : {}) },
    })
  }
  if (event.type.startsWith("child_run.") || event.type.startsWith("child_fan_out.member."))
    return applyChild(projection, turnId, event)
  const block = genericBlock(turnId, event)
  if (block === undefined) return projection
  const updated = upsertUnit(
    projection,
    unit(genericKey(turnId, event, block), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
  return block._tag === "Permission" && block.status === "pending" ? advanceModelPhase(updated, turnId) : updated
}

export const applyEvent: {
  (projection: Projection, event: SourceEvent): Projection
  (event: SourceEvent): (projection: Projection) => Projection
} = Function.dual(2, (projection: Projection, event: SourceEvent): Projection => {
  if (event.sequence <= projection.revision) return projection
  const turnId = projection.units[0]?.turnId ?? ""
  const next = applyKnownEvent(projection, turnId, event)
  return {
    ...next,
    revision: event.sequence,
    ...(projection.oldestCursor === undefined ? { oldestCursor: event.cursor } : {}),
    checkpointCursor: event.cursor,
  }
})

export const project: {
  (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection
  (prompt: string, events: ReadonlyArray<SourceEvent>): (turnId: string) => Projection
} = Function.dual(3, (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection => {
  let projection = empty(turnId, prompt)
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence))
    projection = applyEvent(projection, event)
  return projection
})

export interface NestedProjection {
  readonly parentId: string
  readonly projection: Projection
}

const attachParent = (candidate: Unit, parentId: string): Unit => ({ ...candidate, parentId })
const assignOrder = (candidate: Unit, sequence: number): Unit => ({
  ...candidate,
  order: { sequence, part: 0 },
})

export const withNestedProjections: {
  (root: Projection, nested: ReadonlyArray<NestedProjection>): Projection
  (nested: ReadonlyArray<NestedProjection>): (root: Projection) => Projection
} = Function.dual(2, (root: Projection, nested: ReadonlyArray<NestedProjection>): Projection => {
  const rootTurnId = root.units.find((candidate) => candidate.parentId === undefined)?.turnId ?? root.units[0]?.turnId
  const units = [
    ...root.units.filter((candidate) => candidate.parentId === undefined && candidate.turnId === rootTurnId),
    ...nested.flatMap(({ parentId, projection }) =>
      projection.units.map((candidate) => attachParent(candidate, parentId)),
    ),
  ].map(assignOrder)
  return { ...root, units }
})
