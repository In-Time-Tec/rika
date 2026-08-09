import { ToolContext } from "@batonfx/core"
import { AgentDirectory, ChildAdmission, Runtime, RunTree } from "@batonfx/runtime"
import { AgentDirectoryUnavailable, AgentPort } from "@rika/kernel/agent-port"
import { Effect, Layer } from "effect"

const unavailable = (reason: AgentDirectoryUnavailable["reason"], cause: unknown) =>
  AgentDirectoryUnavailable.make({
    reason,
    message: cause instanceof Error ? cause.message : String(cause),
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

const statusOf = (status: string) =>
  status === "queued" || status === "needs-resolution" ? ("pending" as const) : (status as never)

const inspectionOf = (input: {
  readonly runId: string
  readonly status: string
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
  const children = (parentRunId: string) =>
    Effect.flatMap(ambientRuntime, (runtime) =>
      RunTree.inspect(parentRunId).pipe(
        Effect.provideService(Runtime.Runtime, runtime),
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
  const ownedChild = (parentRunId: string, childRunId: string) =>
    Effect.flatMap(children(parentRunId), (all) => {
      const found = all.find((child) => child.childRunId === childRunId)
      return found === undefined
        ? Effect.fail(unavailable("parentage", `Run ${childRunId} is not a child of this execution`))
        : Effect.succeed(found)
    })
  return AgentPort.of({
    spawn: (input) =>
      Effect.flatMap(identity, (self) =>
        Effect.flatMap(ambientRuntime, (runtime) =>
          runtime
            .spawn({
              parentRunId: self.runId,
              invocationId: ChildAdmission.invocationIdFor({ toolCallId: self.toolCallId, key: input.key }),
              selection: input.profile,
              prompt: input.prompt,
              idempotencyKey: input.key,
              metadata: { productIntent: "cell-child", originOperation: self.toolCallId },
            })
            .pipe(
              Effect.map((receipt) => ({ childRunId: receipt.runId, key: input.key, duplicate: false })),
              Effect.mapError(failed),
            ),
        ),
      ),
    list: Effect.flatMap(identity, (self) => children(self.runId)),
    inspect: (childRunId) => Effect.flatMap(identity, (self) => ownedChild(self.runId, childRunId)),
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
              to: AgentDirectory.sessionAddress(input.to),
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
                prompt: typeof entry.prompt === "string" ? entry.prompt : JSON.stringify(entry.prompt),
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
        runtime.directory(self.runId).pipe(
          Effect.map((entries) =>
            entries.map((entry) => ({
              address: String(entry.address),
              runId: entry.runId,
              sessionId: entry.sessionId,
              ...(entry.name === undefined ? {} : { name: String(entry.name) }),
              relationship: "child" as const,
            })),
          ),
          Effect.mapError(failed),
        ),
      ),
    ),
  })
})

/** Rika's view of Baton's in-execution child and messaging operations, over the real Runtime. */
export const runtimeAgentPortLayer: Layer.Layer<AgentPort> = Layer.effect(AgentPort, make)
