import { ToolContext } from "@batonfx/core"
import { Address, ChildAdmission, Run, Runtime, RunTree } from "@batonfx/runtime"
import { AgentDirectoryUnavailable, AgentPort } from "@rika/kernel/agent-port"
import { Effect, Layer } from "effect"
import type { Prompt } from "effect/unstable/ai"

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  if (typeof cause === "object" && cause !== null) {
    const own = "message" in cause ? cause.message : undefined
    if (typeof own === "string" && own.length > 0) return own
    const tag = "_tag" in cause ? String(cause._tag) : ""
    /**
     * A typed failure carries the fields that explain it even when it carries no prose. Reporting
     * the tag alone told a cell which rule it broke but not what it named.
     */
    const detail = Object.entries(cause)
      .filter(([field, value]) => field !== "_tag" && (typeof value === "string" || typeof value === "number"))
      .map(([field, value]) => `${field}=${String(value)}`)
    if (tag.length > 0) return detail.length === 0 ? tag : `${tag} (${detail.join(", ")})`
  }
  const text = String(cause)
  return text.length > 0 && text !== "[object Object]" ? text : "the agent directory refused the request"
}

const unavailable = (reason: AgentDirectoryUnavailable["reason"], cause: unknown) =>
  AgentDirectoryUnavailable.make({
    reason,
    /**
     * A tagged failure is an object whose own `message` is where its account lives, and stringifying
     * it produced an empty line. A cell told only that a spawn failed cannot tell a bad profile from
     * a closed run.
     */
    message: messageOf(cause),
  })

const reasonOf = (cause: unknown): AgentDirectoryUnavailable["reason"] => {
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : ""
  if (tag.endsWith("/ChildParentageInvalid")) return "parentage"
  if (tag.endsWith("/RunNotFound")) return "not-found"
  if (tag.endsWith("/RunTerminal")) return "terminal"
  if (tag.endsWith("/MessageUnauthorized") || tag.endsWith("/DirectoryUnauthorized")) return "unauthorized"
  if (tag.endsWith("/RunBudgetExhausted")) return "bounded"
  return "unavailable"
}

const failed = (cause: unknown) => unavailable(reasonOf(cause), cause)

/**
 * Parentage and sender identity are read from the ambient ToolContext, never from cell input, so a
 * cell cannot admit, inspect, cancel, or send under a Run it does not own.
 */
const identity = Effect.gen(function* () {
  const ambient = yield* Effect.serviceOption(ToolContext.ToolContext)
  if (ambient._tag === "None")
    return yield* unavailable("parentage", "the rika surface was called outside an executing cell")
  const context = ambient.value
  const runId = context.runId
  if (runId === undefined) return yield* unavailable("parentage", "the executing cell has no Run identity")
  return { runId, sessionId: context.sessionId, toolCallId: context.toolCallId ?? context.operationKey ?? runId }
})

type ChildStatus = "pending" | "running" | "waiting" | "cancelling" | "succeeded" | "failed" | "cancelled"

/**
 * Baton's `queued` and `needs-resolution` are both "admitted but not yet producing", which is the
 * one state the cell contract calls `pending`. The mapping is total over Baton's RunStatus, so a
 * status Rika does not name cannot reach a cell unmapped.
 */
const statusOf = (status: Run.RunStatus): ChildStatus => {
  switch (status) {
    case "queued":
    case "needs-resolution":
      return "pending"
    case "running":
      return "running"
    case "waiting":
      return "waiting"
    case "cancelling":
      return "cancelling"
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

const inspectionOf = (input: {
  readonly runId: string
  readonly status: Run.RunStatus
  readonly invocationId?: string | undefined
  readonly outcome?: unknown
}) => {
  const origin = input.invocationId === undefined ? undefined : ChildAdmission.originOf(input.invocationId)
  return {
    childRunId: input.runId,
    status: statusOf(input.status),
    ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
    ...(origin === undefined ? {} : { origin }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  }
}

/**
 * A mailbox entry carries a `Prompt`, never a string. The cell reads the message a sender wrote, so
 * the text parts are joined rather than the envelope being serialized as JSON.
 */
const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) =>
      message.role === "user" || message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    )
    .join("\n")

/**
 * The relationship the port reports is derived from durable parentage, exactly as Baton derives it.
 * An entry Baton reached under host policy rather than a derived link has no relationship, and is
 * reported as `policy` rather than being claimed as a child.
 */
const relationshipOf = (
  sender: { readonly runId: string; readonly parentRunId?: string | undefined },
  target: { readonly runId: string; readonly parentRunId?: string | undefined },
): "self" | "parent" | "child" | "sibling" | "policy" => {
  if (sender.runId === target.runId) return "self"
  if (sender.parentRunId !== undefined && sender.parentRunId === target.runId) return "parent"
  if (target.parentRunId !== undefined && target.parentRunId === sender.runId) return "child"
  if (sender.parentRunId !== undefined && sender.parentRunId === target.parentRunId) return "sibling"
  return "policy"
}

const ambientRuntime = Effect.flatMap(Effect.serviceOption(Runtime.Runtime), (runtime) =>
  runtime._tag === "None"
    ? Effect.fail(unavailable("unavailable", "the durable runtime is not available to this cell"))
    : Effect.succeed(runtime.value),
)

/**
 * Every operation resolves the Runtime from the ambient execution context rather than closing over
 * it. The pool the cell route builds is Server-scoped and is composed BEFORE the Runtime it runs
 * under, so binding one here would invert that order; reading it per call also keeps the port
 * honest when a cell somehow reaches it outside an execution.
 */
const make: Effect.Effect<AgentPort["Service"]> = Effect.sync(() => {
  /**
   * A Run's direct children, read from its TREE.
   *
   * The tree is addressed by its ROOT, not by any Run in it: Baton records a tree root only for a
   * Run whose id is its own root, so inspecting a nested parent directly reports no such tree. A
   * subagent that spawns its own child is exactly that case, so the root is resolved first and the
   * children are filtered out of the whole tree.
   */
  const rootOf = (
    runtime: Runtime.Runtime["Service"],
    runId: string,
  ): Effect.Effect<string, AgentDirectoryUnavailable> =>
    runtime.inspect(runId).pipe(
      Effect.mapError(failed),
      Effect.flatMap((own) =>
        own.parentRunId === undefined ? Effect.succeed(runId) : rootOf(runtime, own.parentRunId),
      ),
    )
  const children = (parentRunId: string) =>
    Effect.flatMap(ambientRuntime, (runtime) =>
      rootOf(runtime, parentRunId).pipe(
        Effect.flatMap((rootRunId) => RunTree.inspect(rootRunId).pipe(Effect.provideService(Runtime.Runtime, runtime))),
        Effect.map((inspection) =>
          inspection.runs
            .filter((entry) => entry.parentRunId === parentRunId)
            .map((entry) =>
              inspectionOf({
                runId: entry.run.runId,
                status: entry.run.status,
                invocationId: entry.invocationId,
                ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
              }),
            ),
        ),
        Effect.mapError(failed),
      ),
    )
  /**
   * The ordinal one spawn is admitted under, read from the children this operation already admitted
   * under the SAME admission key.
   *
   * The ordinal separates two spawns that share a key, which is what two spawns of one profile from
   * one cell do. It cannot be a count of all children this operation admitted: a replayed cell
   * re-runs its spawns, and a count would climb past the ordinals the first attempt used and mint a
   * fresh child for every replay. Scoping the sequence to the key makes it recompute the same
   * values, so a replayed spawn presents the key Baton already recorded and is recognised as the
   * duplicate it is.
   */
  const originFor = (self: { readonly runId: string; readonly toolCallId: string }, key: string) =>
    Effect.map(children(self.runId), (admitted) => {
      const ordinals = admitted.flatMap((child) =>
        child.origin?.operationKey === self.toolCallId &&
        child.invocationId !== undefined &&
        ChildAdmission.admissionOf(child.invocationId)?.key === key
          ? [child.origin.ordinal]
          : [],
      )
      return { operationKey: self.toolCallId, ordinal: ordinals.length }
    })
  const ownedChildren = (parentRunId: string, childRunIds: ReadonlyArray<string>) =>
    Effect.flatMap(children(parentRunId), (all) => {
      const byRunId = new Map(all.map((child) => [child.childRunId, child]))
      return Effect.forEach(childRunIds, (childRunId) => {
        const found = byRunId.get(childRunId)
        return found === undefined
          ? Effect.fail(unavailable("parentage", `Run ${childRunId} is not a child of this execution`))
          : Effect.succeed(found)
      })
    })
  const ownedChild = (parentRunId: string, childRunId: string) =>
    Effect.map(ownedChildren(parentRunId, [childRunId]), ([found]) => found!)
  return AgentPort.of({
    spawn: (input) =>
      Effect.flatMap(identity, (self) =>
        Effect.flatMap(originFor(self, input.key), (origin) =>
          Effect.flatMap(ambientRuntime, (runtime) =>
            runtime
              .spawn({
                parentRunId: self.runId,
                invocationId: ChildAdmission.invocationIdFor({
                  toolCallId: self.toolCallId,
                  key: input.key,
                  origin,
                }),
                selection: input.profile,
                prompt: input.prompt,
                /**
                 * The ordinal travels in the idempotency key as well as the invocation id. Two
                 * spawns of one profile from one cell share the binding's admission key, so
                 * without it Baton would read the second as a repeat of the first.
                 */
                idempotencyKey: `${input.key}#${origin.ordinal}`,
                metadata: { productIntent: "cell-child", originOperation: self.toolCallId },
              })
              .pipe(
                Effect.map((receipt) => ({ childRunId: receipt.runId, key: input.key, duplicate: receipt.duplicate })),
                Effect.mapError(failed),
              ),
          ),
        ),
      ),
    list: Effect.flatMap(identity, (self) => children(self.runId)),
    inspect: (childRunId) => Effect.flatMap(identity, (self) => ownedChild(self.runId, childRunId)),
    inspectAll: (childRunIds) => Effect.flatMap(identity, (self) => ownedChildren(self.runId, childRunIds)),
    cancel: (input) =>
      Effect.flatMap(identity, (self) =>
        ownedChild(self.runId, input.childRunId).pipe(
          Effect.andThen(
            Effect.flatMap(ambientRuntime, (runtime) =>
              runtime
                .cancel({ runId: input.childRunId, reason: input.reason ?? "Cancelled from a cell" })
                .pipe(Effect.mapError(failed)),
            ),
          ),
        ),
      ),
    send: (input) =>
      Effect.flatMap(identity, (self) =>
        Effect.flatMap(ambientRuntime, (runtime) =>
          runtime
            .sendMessage({
              to: Address.make(input.to),
              fromRunId: self.runId,
              idempotencyKey: input.idempotencyKey,
              prompt: input.prompt,
              ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
            })
            .pipe(
              Effect.map((receipt) => ({
                messageId: receipt.messageId,
                entryId: receipt.entryId,
                duplicate: receipt.duplicate,
              })),
              Effect.mapError(failed),
            ),
        ),
      ),
    inbox: (limit) =>
      Effect.flatMap(identity, (self) =>
        Effect.flatMap(ambientRuntime, (runtime) =>
          runtime.messages({ runId: self.runId, limit }).pipe(
            Effect.map((entries) =>
              entries.map((entry) => ({
                entryId: entry.entryId,
                sequence: entry.sequence,
                from: String(entry.from),
                prompt: promptText(entry.prompt),
                messageId: entry.messageId,
                ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
                ...(entry.inReplyTo === undefined ? {} : { inReplyTo: entry.inReplyTo }),
              })),
            ),
            Effect.mapError(failed),
          ),
        ),
      ),
    directory: Effect.flatMap(identity, (self) =>
      Effect.flatMap(ambientRuntime, (runtime) =>
        Effect.map(
          Effect.all([
            runtime.directory(self.runId).pipe(Effect.mapError(failed)),
            runtime.inspect(self.runId).pipe(Effect.mapError(failed)),
          ]),
          ([entries, own]) =>
            entries.map((entry) => ({
              address: String(entry.address),
              runId: entry.runId,
              sessionId: entry.sessionId,
              ...(entry.name === undefined ? {} : { name: String(entry.name) }),
              relationship: relationshipOf({ runId: self.runId, parentRunId: own.parentRunId }, entry),
            })),
        ),
      ),
    ),
  })
})

/** Rika's view of Baton's in-execution child and messaging operations, over the real Runtime. */
export const runtimeAgentPortLayer: Layer.Layer<AgentPort> = Layer.effect(AgentPort, make)
