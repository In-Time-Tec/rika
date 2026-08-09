import type { Event, Message, Part, PermissionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type * as ThreadView from "@rika/product/thread-view"

type Snapshot = ThreadView.ThreadViewSnapshot
type ViewTurn = Snapshot["turns"][number]
type Unit = ViewTurn["units"][number]
type Usage = ViewTurn["usage"]
type AuthorizationTarget = {
  readonly threadId: string
  readonly turnId: string
  readonly authorizationId: string
}

export type ProjectedThread = {
  readonly session: Session
  readonly messages: ReadonlyArray<Message>
  readonly parts: ReadonlyArray<Part>
  readonly permissions: ReadonlyArray<PermissionRequest>
  readonly status: SessionStatus
  readonly authorizationIndex: ReadonlyMap<string, AuthorizationTarget>
}

const terminal = new Set(["completed", "failed", "cancelled"])
const active = new Set(["accepted", "running", "waiting", "cancelling"])
const numberWidth = 16

const encodeNumber = (value: number, offset: number) =>
  (BigInt(value) + BigInt(offset)).toString(10).padStart(numberWidth, "0")

const encodeKey = (value: string) => {
  let encoded = ""
  for (let index = 0; index < value.length; index += 1) encoded += value.charCodeAt(index).toString(16).padStart(4, "0")
  return `${encoded}/`
}

const encodeOrder = (order: Unit["order"]) =>
  order
    .map((segment) => `${encodeNumber(segment.sequence, 1)}${encodeNumber(segment.part, 0)}${encodeKey(segment.key)}`)
    .join("")

const messageId = (turnId: string, role: "user" | "assistant") =>
  `rika-message:${encodeURIComponent(turnId)}:${role === "user" ? "0" : "1"}`

const partId = (unit: Unit, ordinal = 0) =>
  `rika-part:${encodeOrder(unit.order)}${encodeKey(unit.key)}${ordinal.toString().padStart(4, "0")}`

const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

const tokens = (usage: Usage) => {
  const value = usage.tokens
  if (!value) return emptyTokens()
  const input = value.input.total ?? 0
  const output = value.output.total ?? 0
  const reasoning = value.output.reasoning ?? 0
  const total = value.total
  return {
    ...(total === undefined ? {} : { total }),
    input,
    output,
    reasoning,
    cache: { read: value.input.cacheRead ?? 0, write: value.input.cacheWrite ?? 0 },
  }
}

const sessionTokens = (usage: Snapshot["usage"]) => {
  const value = usage.state.tokens
  if (!value) return undefined
  return {
    input: value.input.total ?? 0,
    output: value.output.total ?? 0,
    reasoning: value.output.reasoning ?? 0,
    cache: { read: value.input.cacheRead ?? 0, write: value.input.cacheWrite ?? 0 },
  }
}

export const projectThread = (thread: Snapshot["thread"], usage?: Snapshot["usage"]): Session => {
  const projectedTokens = usage === undefined ? undefined : sessionTokens(usage)
  return {
    id: thread.id,
    slug: `rika-${encodeURIComponent(thread.id)}`,
    projectID: thread.workspace,
    directory: thread.workspace,
    title: thread.title,
    version: "rika",
    time: {
      created: thread.createdAt,
      updated: thread.updatedAt,
      ...(thread.archived ? { archived: thread.updatedAt } : {}),
    },
    ...(usage?.state.costNanoUsd === undefined ? {} : { cost: usage.state.costNanoUsd / 1_000_000_000 }),
    ...(projectedTokens === undefined ? {} : { tokens: projectedTokens }),
    metadata: { labels: thread.labels, pinned: thread.pinned, lineage: thread.lineage },
  }
}

const parseInput = (input: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(input)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : { value: parsed }
  } catch {
    return { text: input }
  }
}

const toolPart = (
  snapshot: Snapshot,
  entry: ViewTurn,
  unit: Unit,
  block: Extract<Unit["content"], { _tag: "Block" }>["block"],
): Part | undefined => {
  if (block._tag !== "ToolCall" && block._tag !== "AuthorizationCard") return undefined
  const sessionID = snapshot.thread.id
  const messageID = messageId(entry.turn.id, "assistant")
  if (block._tag === "AuthorizationCard") {
    const input = { capability: block.capability, input: block.input }
    const state =
      block.status === "pending"
        ? ({ status: "running", input, title: block.operation, time: { start: entry.turn.createdAt } } as const)
        : block.status === "approved"
          ? ({
              status: "completed",
              input,
              output: "Approved",
              title: block.operation,
              metadata: { authorizationStatus: block.status },
              time: { start: entry.turn.createdAt, end: entry.turn.updatedAt },
            } as const)
          : ({
              status: "error",
              input,
              error: block.status === "denied" ? "Denied" : block.status,
              metadata: { authorizationStatus: block.status },
              time: { start: entry.turn.createdAt, end: entry.turn.updatedAt },
            } as const)
    return {
      id: partId(unit),
      sessionID,
      messageID,
      type: "tool",
      callID: block.id,
      tool: block.operation,
      state,
      metadata: { unitKey: unit.key, inputTruncated: block.inputTruncated },
    }
  }
  const input = parseInput(block.input)
  const metadata = {
    detail: block.detail,
    presentation: block.presentation,
    process: block.process,
    files: block.files,
    unitKey: unit.key,
  }
  const state =
    block.status === "running"
      ? ({
          status: "running",
          input,
          title: block.presentation.activeLabel,
          metadata,
          time: { start: entry.turn.createdAt },
        } as const)
      : block.status === "complete"
        ? ({
            status: "completed",
            input,
            output: block.output ?? block.detail,
            title: block.presentation.completeLabel,
            metadata,
            time: { start: entry.turn.createdAt, end: entry.turn.updatedAt },
          } as const)
        : ({
            status: "error",
            input,
            error: block.output ?? (block.detail || (block.status === "rejected" ? "Rejected" : "Cancelled")),
            metadata: { ...metadata, rikaStatus: block.status },
            time: { start: entry.turn.createdAt, end: entry.turn.updatedAt },
          } as const)
  return {
    id: partId(unit),
    sessionID,
    messageID,
    type: "tool",
    callID: block.id,
    tool: block.name,
    state,
    metadata: { unitKey: unit.key },
  }
}

const textPart = (
  snapshot: Snapshot,
  entry: ViewTurn,
  unit: Unit,
  text: string,
  synthetic = true,
  ignored = false,
): Part => ({
  id: partId(unit),
  sessionID: snapshot.thread.id,
  messageID: messageId(
    entry.turn.id,
    unit.content._tag === "Entry" && unit.content.role === "user" ? "user" : "assistant",
  ),
  type: "text",
  text,
  ...(synthetic ? { synthetic: true } : {}),
  ...(ignored ? { ignored: true } : {}),
  metadata: { unitKey: unit.key, unitRevision: unit.revision },
})

const projectUnit = (snapshot: Snapshot, entry: ViewTurn, unit: Unit): Part | undefined => {
  if (unit.content._tag === "Entry")
    return textPart(snapshot, entry, unit, unit.content.text, unit.content.role === "notice")
  const block = unit.content.block
  const tool = toolPart(snapshot, entry, unit, block)
  if (tool) return tool
  const base = {
    id: partId(unit),
    sessionID: snapshot.thread.id,
    messageID: messageId(entry.turn.id, "assistant"),
  }
  switch (block._tag) {
    case "Reasoning":
      return {
        ...base,
        type: "reasoning",
        text: block.text,
        time: {
          start: entry.turn.createdAt,
          ...(terminal.has(entry.turn.status) ? { end: entry.turn.updatedAt } : {}),
        },
        metadata: { unitKey: unit.key, unitRevision: unit.revision },
      }
    case "ToolResult":
      return textPart(snapshot, entry, unit, block.output)
    case "Diff":
      return textPart(snapshot, entry, unit, `${block.path}\n${block.patch}`)
    case "ContextUsage":
      return textPart(snapshot, entry, unit, block.cost ? `${block.text}\n${block.cost}` : block.text, true, true)
    case "Compaction":
      return textPart(snapshot, entry, unit, block.summary)
    case "Notification":
      return textPart(snapshot, entry, unit, `${block.title}\n${block.detail}`)
    case "Error":
      return textPart(snapshot, entry, unit, `${block.title}\n${block.detail}`)
    case "SubagentCard":
      return {
        ...base,
        type: "subtask",
        prompt: block.prompt,
        description: block.summary || block.name,
        agent: block.name,
      }
    case "ImageAttachment":
      return textPart(snapshot, entry, unit, `${block.name} (${block.mediaType})`)
    case "ToolCall":
    case "AuthorizationCard":
      return undefined
  }
}

const assistantError = (entry: ViewTurn): Extract<Message, { role: "assistant" }>["error"] => {
  if (entry.turn.status === "cancelled")
    return { name: "MessageAbortedError", data: { message: "Rika turn cancelled" } }
  if (entry.turn.status !== "failed") return undefined
  const error = entry.units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")
  const message =
    error?.content._tag === "Block" && error.content.block._tag === "Error"
      ? `${error.content.block.title}: ${error.content.block.detail}`
      : "Rika turn failed"
  return { name: "UnknownError", data: { message } }
}

export type ProjectionModel = { readonly providerID: string; readonly modelID: string }
const unknownModel: ProjectionModel = { providerID: "rika", modelID: "unknown" }

const projectTurn = (snapshot: Snapshot, entry: ViewTurn, model: ProjectionModel) => {
  const userID = messageId(entry.turn.id, "user")
  const assistantID = messageId(entry.turn.id, "assistant")
  const user: Message = {
    id: userID,
    sessionID: snapshot.thread.id,
    role: "user",
    time: { created: entry.turn.createdAt },
    agent: "rika",
    model,
  }
  const error = assistantError(entry)
  const assistant: Message = {
    id: assistantID,
    sessionID: snapshot.thread.id,
    role: "assistant",
    time: {
      created: entry.turn.createdAt,
      ...(terminal.has(entry.turn.status) ? { completed: entry.turn.updatedAt } : {}),
    },
    ...(error === undefined ? {} : { error }),
    parentID: userID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "default",
    agent: "rika",
    path: { cwd: snapshot.thread.workspace, root: snapshot.thread.workspace },
    cost: entry.usage.costNanoUsd === undefined ? 0 : entry.usage.costNanoUsd / 1_000_000_000,
    tokens: tokens(entry.usage),
  }
  const projected = entry.units.flatMap((unit) => {
    const part = projectUnit(snapshot, entry, unit)
    return part === undefined ? [] : [part]
  })
  const hasUserPart = projected.some((part) => part.messageID === userID)
  const promptPart: Part | undefined =
    hasUserPart || entry.turn.prompt.length === 0
      ? undefined
      : {
          id: "rika-part:!prompt",
          sessionID: snapshot.thread.id,
          messageID: userID,
          type: "text",
          text: entry.turn.prompt,
          metadata: { turnId: entry.turn.id },
        }
  const shellPart: Part | undefined =
    entry.turn.kind !== "shell"
      ? undefined
      : {
          id: "rika-part:~shell",
          sessionID: snapshot.thread.id,
          messageID: assistantID,
          type: "tool",
          callID: `shell:${entry.turn.id}`,
          tool: "bash",
          state:
            entry.turn.result === undefined
              ? { status: "running", input: { command: entry.turn.command }, time: { start: entry.turn.createdAt } }
              : entry.turn.status === "completed"
                ? {
                    status: "completed",
                    input: { command: entry.turn.command },
                    output: entry.turn.result.text,
                    title: entry.turn.command,
                    metadata: { truncated: entry.turn.result.truncated },
                    time: { start: entry.turn.createdAt, end: entry.turn.updatedAt },
                  }
                : {
                    status: "error",
                    input: { command: entry.turn.command },
                    error: entry.turn.result.text,
                    time: { start: entry.turn.createdAt, end: entry.turn.updatedAt },
                  },
        }
  return {
    messages: [user, assistant] as ReadonlyArray<Message>,
    parts: [...(promptPart ? [promptPart] : []), ...projected, ...(shellPart ? [shellPart] : [])],
  }
}

const projectPermission = (snapshot: Snapshot, entry: ViewTurn, unit: Unit): PermissionRequest | undefined => {
  if (unit.content._tag !== "Block" || unit.content.block._tag !== "AuthorizationCard") return undefined
  const card = unit.content.block
  if (card.status !== "pending") return undefined
  return {
    id: card.id,
    sessionID: snapshot.thread.id,
    permission: card.capability,
    patterns: [card.input],
    metadata: {
      operation: card.operation,
      inputTruncated: card.inputTruncated,
      turnID: entry.turn.id,
      unitKey: unit.key,
    },
    always: [],
    tool: { messageID: messageId(entry.turn.id, "assistant"), callID: card.id },
  }
}

export const projectStatus = (snapshot: Snapshot): SessionStatus =>
  snapshot.turns.some((entry) => active.has(entry.turn.status)) ? { type: "busy" } : { type: "idle" }

export const projectSnapshot = (snapshot: Snapshot, model: ProjectionModel = unknownModel): ProjectedThread => {
  const turns = snapshot.turns.map((entry) => projectTurn(snapshot, entry, model))
  const permissions: PermissionRequest[] = []
  const authorizationIndex = new Map<string, AuthorizationTarget>()
  for (const entry of snapshot.turns) {
    for (const unit of entry.units) {
      const permission = projectPermission(snapshot, entry, unit)
      if (!permission) continue
      permissions.push(permission)
      authorizationIndex.set(permission.id, {
        threadId: snapshot.thread.id,
        turnId: entry.turn.id,
        authorizationId: permission.id,
      })
    }
  }
  return {
    session: projectThread(snapshot.thread, snapshot.usage),
    messages: turns.flatMap((turn) => turn.messages),
    parts: turns
      .flatMap((turn) => turn.parts)
      .toSorted((left, right) =>
        left.messageID === right.messageID
          ? left.id.localeCompare(right.id)
          : left.messageID.localeCompare(right.messageID),
      ),
    permissions: permissions.toSorted((left, right) => left.id.localeCompare(right.id)),
    status: projectStatus(snapshot),
    authorizationIndex,
  }
}
