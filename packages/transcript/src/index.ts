import { Catalog } from "@rika/tools"
import { Function, Option, Schema } from "effect"
import { pricingVersion, usageCostUsd, usageTokens } from "./model-cost"
import { partialInputRecord } from "./partial-input"
import type { Block, Content, Presentation, Projection, SourceEvent, ToolFile, ToolProcess, Unit } from "./schema"

export * from "./schema"
export { pricingVersion, usageTokens, type UsageTokens } from "./model-cost"
export { partialInputRecord } from "./partial-input"

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

const makeUnit = (
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
    ...makeUnit(`execution:${turnId}:outcome`, turnId, Number.MAX_SAFE_INTEGER, 0, revision, {
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

const lineCounts = (patch: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
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
    let kind: ToolFile["kind"] = "update"
    if (created) kind = "add"
    else if (deleted) kind = "delete"
    else if (previousPath !== path) kind = "move"
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

const durableToolCallPrefix = /^rika:([^:]+):/

const providerCallId = (id: string): string => {
  const match = durableToolCallPrefix.exec(id)
  if (match === null) return id
  try {
    const namespace = decodeURIComponent(match[1]!)
    return namespace.startsWith("execution:") || namespace.startsWith("child:") || namespace.startsWith("workflow:")
      ? id.slice(match[0].length)
      : id
  } catch {
    return id
  }
}

const childScopeAndCallId = (
  childExecutionId: string,
): { readonly scope: string; readonly callId: string; readonly rawCallId: string } | undefined => {
  if (childExecutionId.startsWith("child:")) {
    const separator = childExecutionId.indexOf(":", "child:".length)
    if (separator < 0) return undefined
    try {
      const rawCallId = childExecutionId.slice(separator + 1)
      return {
        scope: executionKey(decodeURIComponent(childExecutionId.slice("child:".length, separator))),
        callId: providerCallId(rawCallId),
        rawCallId,
      }
    } catch {
      return undefined
    }
  }
  const key = executionKey(childExecutionId)
  const marker = ":child:"
  const index = key.lastIndexOf(marker)
  if (index < 0) return undefined
  const rawCallId = key.slice(index + marker.length)
  return { scope: key.slice(0, index), callId: providerCallId(rawCallId), rawCallId }
}

const candidateCallId = (candidate: ChildParentCandidate): string => {
  const prefix = `${executionKey(candidate.scope)}:`
  const id = executionKey(candidate.id)
  return providerCallId(id.startsWith(prefix) ? id.slice(prefix.length) : id)
}

export interface ChildParentCandidate {
  readonly id: string
  readonly scope: string
  readonly childId: string | undefined
  readonly family: Presentation["family"]
}

export const childParentMatch: {
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined
  (childExecutionId: string): <A extends ChildParentCandidate>(candidates: Iterable<A>) => A | undefined
} = Function.dual(
  2,
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined => {
    const childKey = executionKey(childExecutionId)
    const list = [...candidates]
    const linked = list.filter(
      (candidate) => candidate.childId !== undefined && executionKey(candidate.childId) === childKey,
    )
    const requesting = linked.find((candidate) => executionKey(candidate.id) !== childKey)
    if (requesting !== undefined) return requesting
    const parsed = childScopeAndCallId(childExecutionId)
    if (parsed !== undefined)
      for (const candidate of list)
        if (
          candidate.family === "agent" &&
          executionKey(candidate.scope) === parsed.scope &&
          candidateCallId(candidate) === parsed.callId
        )
          return candidate
    return linked[0]
  },
)

const toolCandidates = (projection: Projection) =>
  projection.units.flatMap((unit) =>
    unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
      ? [
          {
            id: unit.content.block.id,
            scope: unit.turnId,
            childId: unit.content.block.childId,
            family: unit.content.block.presentation.family,
            block: unit.content.block,
          },
        ]
      : [],
  )

const linkedToolFor = (
  projection: Projection,
  turnId: string,
  childId: string,
  correlatedToolId: string,
): Extract<Block, { _tag: "ToolCall" }> | undefined => {
  const correlated = correlatedToolId.length > 0 ? toolAt(projection, eventId(turnId, correlatedToolId)) : undefined
  if (correlated !== undefined) return correlated
  const matched = childParentMatch(toolCandidates(projection), childId)?.block
  if (matched !== undefined) return matched
  const parsed = childScopeAndCallId(childId)
  return parsed === undefined ? undefined : toolAt(projection, eventId(turnId, parsed.rawCallId))
}

const agentPresentationFor = (name: string): Presentation => {
  const profile = name.toLowerCase()
  if (profile === "task" || profile === "child" || profile === "subagent") return Catalog.resolvePresentation("task")
  if (profile === "oracle" || profile === "librarian") return Catalog.resolvePresentation(profile)
  return Catalog.resolvePresentation(`transfer_to_${profile}`)
}

export const ensureChildTool: {
  (
    projection: Projection,
    childExecutionId: string,
    name: string,
  ): { readonly projection: Projection; readonly tool: Extract<Block, { _tag: "ToolCall" }> }
  (
    childExecutionId: string,
    name: string,
  ): (projection: Projection) => {
    readonly projection: Projection
    readonly tool: Extract<Block, { _tag: "ToolCall" }>
  }
} = Function.dual(
  3,
  (
    projection: Projection,
    childExecutionId: string,
    name: string,
  ): { readonly projection: Projection; readonly tool: Extract<Block, { _tag: "ToolCall" }> } => {
    const existing = childParentMatch(toolCandidates(projection), childExecutionId)?.block
    if (existing !== undefined) return { projection, tool: existing }
    const id = executionKey(childExecutionId)
    const block: Extract<Block, { _tag: "ToolCall" }> = {
      _tag: "ToolCall",
      id,
      name,
      input: "",
      status: "running",
      presentation: agentPresentationFor(name),
      detail: "",
      files: [],
      childId: childExecutionId,
    }
    const turnId = projection.units[0]?.turnId ?? ""
    const next = upsertUnit(
      projection,
      makeUnit(`tool:${id}`, turnId, projection.revision, 0, projection.revision, { _tag: "Block", block }),
    )
    return { projection: next, tool: block }
  },
)

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

const usageCost = (value: Record<string, unknown>): number | undefined => usageCostUsd(value)

const applyUsage = (projection: Projection, event: SourceEvent): Projection => {
  if (event.executionId === undefined || event.id === undefined) return projection
  const identity = `${event.executionId}\u0000${event.id}`
  if ((projection.usageCursors ?? []).includes(identity)) return projection
  const cost = usageCost(sourcePayload(event))
  if (cost === undefined) return projection
  return {
    ...projection,
    costUsd: (projection.costUsd ?? 0) + cost,
    usageCursors: [...(projection.usageCursors ?? []), identity],
    ...(projection.costUsd === undefined || projection.pricingVersion === pricingVersion ? { pricingVersion } : {}),
  }
}

const assistantKey = (turnId: string, phase: number): string => `assistant:${turnId}:${Math.max(0, phase)}`
const reasoningKey = (turnId: string, phase: number): string => `reasoning:${turnId}:${Math.max(0, phase)}`

const assistantText = (event: SourceEvent): string => event.text ?? string(sourcePayload(event).text)

const applyAssistant = (projection: Projection, turnId: string, event: SourceEvent, complete: boolean): Projection => {
  const key = assistantKey(turnId, projection.modelPhase)
  const index = projection.units.findIndex((candidate) => candidate.key === key)
  const current = index < 0 ? undefined : projection.units[index]
  const text = assistantText(event)
  const finish = (next: Projection) =>
    complete && text.trim().length > 0 ? { ...next, usableCompletionSequence: event.sequence } : next
  const aggregateCompletion = complete && typeof sourcePayload(event).model_output === "string"
  if (aggregateCompletion) {
    const hasAssistant = projection.units.some(
      (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
    )
    if (hasAssistant)
      return finish(
        current?.content._tag === "Entry" && current.content.role === "assistant"
          ? replaceUnit(projection, index, { ...current, revision: event.sequence })
          : projection,
      )
  }
  if (current?.content._tag === "Entry" && current.content.role === "assistant")
    return finish(
      replaceUnit(projection, index, {
        ...current,
        revision: event.sequence,
        content: {
          ...current.content,
          text: complete && text.length > 0 ? text : current.content.text + text,
        },
      }),
    )
  if (text.length === 0) return projection
  return finish(
    upsertUnit(
      projection,
      makeUnit(key, turnId, event.sequence, 0, event.sequence, { _tag: "Entry", role: "assistant", text }),
    ),
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
  const linkedTool = linkedToolFor(projection, turnId, childId, correlatedToolId)
  if (linkedTool !== undefined) {
    const id = linkedTool.id
    const childState = childStatus(event, value)
    const profile = string(value.profile ?? value.preset_name ?? value.name).toLowerCase()
    const presentation = profile.length === 0 ? linkedTool.presentation : agentPresentationFor(profile)
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
    makeUnit(key, turnId, current?.order.sequence ?? event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const permissionStatus = (requested: boolean, approved: unknown): Extract<Block, { _tag: "Permission" }>["status"] => {
  if (requested) return "pending"
  if (approved === false) return "denied"
  return "approved"
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
      status: permissionStatus(event.type === "tool.approval.requested", value.approved),
    }
  if (event.type === "permission.ask.requested" || event.type === "permission.ask.resolved")
    return {
      _tag: "Permission",
      id: string(value.wait_id ?? value.permission_id, event.cursor),
      kind: "permission",
      title: string(value.title ?? value.tool_name ?? value.name, "Permission required"),
      detail: encodeInput(value.input),
      status: permissionStatus(event.type === "permission.ask.requested", value.approved),
    }
  if (event.type.includes("diff"))
    return { _tag: "Diff", path: string(value.path, "diff"), patch: event.text ?? string(value.patch ?? value.diff) }
  if (event.type === "agent.compaction.started")
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary),
      status: "running",
    }
  if (event.type.includes("compact"))
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary),
      status: "complete",
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
  if (event.type.includes("workflow")) {
    let status: Extract<Block, { _tag: "Workflow" }>["status"] = "running"
    if (event.type.includes("failed")) status = "failed"
    else if (event.type.includes("completed")) status = "complete"
    else if (event.type.includes("wait")) status = "waiting"
    return {
      _tag: "Workflow",
      name: string(value.workflow ?? value.name, "workflow"),
      step: event.text ?? string(value.step ?? value.status),
      status,
    }
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
    units: [makeUnit(`turn:${turnId}:user`, turnId, -1, 0, 0, { _tag: "Entry", role: "user", text: prompt })],
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
  const block = toolBlock(id, name, input, previous)
  return upsertUnit(
    projection,
    makeUnit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
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
          return candidate.content.block.name === "bash" && candidate.content.block.process?.processId === processId
        })
  const block =
    parent?.content._tag === "Block" && parent.content.block._tag === "ToolCall"
      ? { ...base, detail: parent.content.block.detail, parentId: parent.content.block.id }
      : base
  return upsertUnit(
    projection,
    makeUnit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const applyToolResult = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const value = resultPayload(event)
  const id = eventId(turnId, rawToolId(event))
  const requested = toolAt(projection, id)
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
  const updated = updateTool(projection, id, event.sequence, (tool) => {
    let status: Extract<Block, { _tag: "ToolCall" }>["status"] = "complete"
    if (failed) status = "failed"
    else if (cancelled) status = "cancelled"
    else if (process?.running === true && tool.name !== "shell_command_status") status = "running"
    return {
      ...tool,
      status,
      output: resultText,
      ...(process === undefined ? {} : { process: { ...tool.process, ...process } }),
      files:
        diff.length > 0
          ? unifiedFiles(id, diff, failed)
          : tool.files.map((file) => ({ ...file, preview: false, status: failed ? "failed" : "complete" })),
    }
  })
  if (updated !== projection) {
    if (
      requested?.name !== "shell_command_status" ||
      requested.parentId === undefined ||
      process?.running === undefined ||
      process.processId === undefined
    )
      return updated
    const parentTool = toolAt(updated, requested.parentId)
    if (parentTool?.status !== "running" || parentTool.process?.processId !== process.processId) return updated
    const running = process.running
    const processId = process.processId
    return updateTool(updated, requested.parentId, event.sequence, (tool) => {
      let status: Extract<Block, { _tag: "ToolCall" }>["status"] = "complete"
      if (process.exitCode !== undefined && process.exitCode !== 0) status = "failed"
      else if (running) status = "running"
      return {
        ...tool,
        status,
        process: {
          ...tool.process,
          processId,
          running,
          ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
        },
      }
    })
  }
  const result: Block = { _tag: "ToolResult", id, output: resultText, failed }
  return upsertUnit(
    projection,
    makeUnit(`tool-result:${id}`, turnId, event.sequence, 0, event.sequence, { _tag: "Block", block: result }),
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
    makeUnit(key, turnId, current?.order.sequence ?? event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const settledBlock = (block: Block, status: "failed" | "cancelled"): Block | undefined => {
  if (block._tag === "ToolCall" && block.status === "running") return { ...block, status }
  if (block._tag === "ChildAgent" && block.status === "running") return { ...block, status }
  return undefined
}

const settleRunningImpl = (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection => {
  let changed = false
  const units = projection.units.map((candidate) => {
    if (candidate.content._tag !== "Block") return candidate
    const settled = settledBlock(candidate.content.block, status)
    if (settled === undefined) return candidate
    changed = true
    return {
      ...candidate,
      revision: Math.max(candidate.revision, sequence),
      content: { _tag: "Block" as const, block: settled },
    }
  })
  return changed ? { ...projection, units } : projection
}

export const settleRunning: {
  (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection
  (status: "failed" | "cancelled", sequence: number): (projection: Projection) => Projection
} = Function.dual(3, settleRunningImpl)

const toolUnitRevision = (projection: Projection, id: string): number => {
  const index = toolIndex(projection, id)
  return index < 0 ? -1 : projection.units[index]!.revision
}

const settleChildImpl = (
  projection: Projection,
  childId: string,
  status: "complete" | "failed" | "cancelled",
  sequence: number,
  reconcile: boolean,
): Projection => {
  const turnId = projection.units[0]?.turnId ?? ""
  const linkedTool = linkedToolFor(projection, turnId, childId, "")
  const settledTool =
    linkedTool === undefined || (!reconcile && linkedTool.status !== "running") || linkedTool.status === status
      ? projection
      : updateTool(
          projection,
          linkedTool.id,
          Math.max(sequence, toolUnitRevision(projection, linkedTool.id)),
          (tool) => ({ ...tool, status }),
        )
  let changed = settledTool !== projection
  const units = settledTool.units.map((candidate) => {
    if (candidate.content._tag !== "Block") return candidate
    const block = candidate.content.block
    if (block._tag !== "ChildAgent" || executionKey(block.id) !== executionKey(childId)) return candidate
    if ((!reconcile && block.status !== "running") || block.status === status) return candidate
    changed = true
    return {
      ...candidate,
      revision: Math.max(candidate.revision, sequence),
      content: { _tag: "Block" as const, block: { ...block, status } },
    }
  })
  return changed ? { ...settledTool, units } : projection
}

export const settleChild: {
  (projection: Projection, childId: string, status: "complete" | "failed" | "cancelled", sequence: number): Projection
  (
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): (projection: Projection) => Projection
} = Function.dual(
  4,
  (projection: Projection, childId: string, status: "complete" | "failed" | "cancelled", sequence: number) =>
    settleChildImpl(projection, childId, status, sequence, false),
)

export const reconcileChild: {
  (projection: Projection, childId: string, status: "complete" | "failed" | "cancelled", sequence: number): Projection
  (
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): (projection: Projection) => Projection
} = Function.dual(
  4,
  (projection: Projection, childId: string, status: "complete" | "failed" | "cancelled", sequence: number) =>
    settleChildImpl(projection, childId, status, sequence, true),
)

export const hasRunningBlocks = (projection: Projection): boolean =>
  projection.units.some(
    (candidate) =>
      candidate.content._tag === "Block" &&
      (candidate.content.block._tag === "ToolCall" || candidate.content.block._tag === "ChildAgent") &&
      candidate.content.block.status === "running",
  )

const advanceModelPhase = (projection: Projection, turnId: string): Projection => {
  const phase = Math.max(0, projection.modelPhase)
  const hasOutput = projection.units.some(
    (candidate) => candidate.key === assistantKey(turnId, phase) || candidate.key === reasoningKey(turnId, phase),
  )
  return hasOutput ? { ...projection, modelPhase: phase + 1 } : projection
}

const hasResponseEvidence = (projection: Projection, turnId: string): boolean =>
  projection.units.some((candidate) => {
    if (candidate.turnId !== turnId || candidate.content._tag !== "Block") return false
    const block = candidate.content.block
    return (
      block._tag === "Reasoning" ||
      block._tag === "ToolCall" ||
      block._tag === "Permission" ||
      block._tag === "ChildAgent"
    )
  }) ||
  projection.units.some(
    (candidate) =>
      candidate.turnId === turnId && candidate.content._tag === "Entry" && candidate.content.role === "assistant",
  )

const hasUsableFinalResponse = (projection: Projection, turnId: string) => {
  const latestToolRevision = projection.units.reduce(
    (latest, candidate) =>
      candidate.turnId === turnId && candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall"
        ? Math.max(latest, candidate.revision)
        : latest,
    -1,
  )
  return projection.usableCompletionSequence !== undefined && projection.usableCompletionSequence > latestToolRevision
}

const steeringMessageTexts = (event: SourceEvent, count: number): ReadonlyArray<string> => {
  const parts = (event.content ?? []).flatMap((part) => {
    const value = record(part)
    return value.type === "text" && typeof value.text === "string" ? [value.text] : []
  })
  if (parts.length === count) return parts.filter((text) => text.length > 0)
  const joined = event.text ?? parts.join("\n")
  return joined.length === 0 ? [] : [joined]
}

const applySteeringDelivered = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const payload = sourcePayload(event)
  const count = typeof payload.message_count === "number" ? payload.message_count : 0
  if (count === 0) return projection
  return steeringMessageTexts(event, count).reduce(
    (updated, text, index) =>
      upsertUnit(
        updated,
        makeUnit(`steering:${turnId}:${event.sequence}:${index}`, turnId, event.sequence, index, event.sequence, {
          _tag: "Entry",
          role: "user",
          text,
        }),
      ),
    projection,
  )
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
  if (event.type === "steering.delivered") return applySteeringDelivered(projection, turnId, event)
  if (event.type === "model.usage.reported") return applyUsage(projection, event)
  if (event.type === "model.attempt.failed" || event.type === "model.call.failed") return projection
  if (event.type === "execution.completed")
    return applyExecutionOutcome(settleRunningImpl(projection, "cancelled", event.sequence), turnId, event.sequence, {
      status: "complete",
    })
  if (event.type === "execution.failed") {
    if (hasUsableFinalResponse(projection, turnId))
      return applyExecutionOutcome(settleRunningImpl(projection, "cancelled", event.sequence), turnId, event.sequence, {
        status: "complete",
      })
    const payload = sourcePayload(event)
    const details = record(payload.details)
    const compactionFailed = details.failure_classification === "context-overflow"
    const reason = event.text ?? string(payload.message, "The execution failed unexpectedly.")
    const block: Block = {
      _tag: "Error",
      title: compactionFailed ? "Auto-compaction failed" : "Execution failed",
      detail: reason,
      turnId,
      recovery: compactionFailed
        ? "Try again. If the thread is still too large, start a new thread."
        : "Edit your prompt and press Enter to try again.",
    }
    return upsertUnit(settleRunningImpl(projection, "failed", event.sequence), {
      ...makeUnit(`execution:${turnId}:failed`, turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
      executionOutcome: { status: "failed", reason },
    })
  }
  if (event.type === "execution.cancelled") {
    const payload = sourcePayload(event)
    const reason = event.text ?? string(payload.reason, string(payload.message))
    const settled = settleRunningImpl(projection, "cancelled", event.sequence)
    const outcome = { status: "cancelled" as const, ...(reason.length > 0 ? { reason } : {}) }
    if (!hasResponseEvidence(projection, turnId)) return applyExecutionOutcome(settled, turnId, event.sequence, outcome)
    return upsertUnit(settled, {
      ...makeUnit(`execution:${turnId}:cancelled`, turnId, event.sequence, 0, event.sequence, {
        _tag: "Entry",
        role: "notice",
        text: reason.length > 0 ? reason : "cancelled",
      }),
      executionOutcome: outcome,
    })
  }
  if (event.type.startsWith("child_run.") || event.type.startsWith("child_fan_out.member."))
    return applyChild(projection, turnId, event)
  const block = genericBlock(turnId, event)
  if (block === undefined) return projection
  const updated = upsertUnit(
    projection,
    makeUnit(genericKey(turnId, event, block), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
  return block._tag === "Permission" && block.status === "pending" ? advanceModelPhase(updated, turnId) : updated
}

export const applyEvent: {
  (projection: Projection, event: SourceEvent): Projection
  (event: SourceEvent): (projection: Projection) => Projection
} = Function.dual(2, (projection: Projection, event: SourceEvent): Projection => {
  if (event.sequence <= projection.revision)
    return event.type === "model.usage.reported" ? applyUsage(projection, event) : projection
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
