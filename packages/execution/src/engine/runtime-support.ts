import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Errors, Run, Runtime } from "generalist/runtime"
import type { Status } from "@rika/product/execution-status"
import { Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

export const message = (cause: unknown) => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  const encoded = JSON.stringify(cause)
  return encoded === undefined || encoded === "{}" ? String(cause) : encoded
}

export const titleRunId = (rootRunId: string) => `${rootRunId}:title`

const isApprovalResponseFailure = Schema.is(ExecutionGateway.ApprovalResponseFailure)
const decodeCauseTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))

export const approvalFailure = (cause: unknown): ExecutionGateway.ApprovalResponseFailure => {
  if (isApprovalResponseFailure(cause)) return cause
  const tag = Option.getOrElse(
    Option.map(decodeCauseTag(cause), (tagged) => tagged._tag),
    () => "",
  )
  let kind: ExecutionGateway.ApprovalResponseFailure["kind"] = "unavailable"
  if (tag.endsWith("/ApprovalStale")) kind = "stale"
  else if (tag.endsWith("/ApprovalMismatch")) kind = "mismatch"
  let failureMessage = "Approval service is unavailable"
  if (kind === "stale") failureMessage = "Authorization is no longer pending"
  else if (kind === "mismatch") failureMessage = "Authorization response conflicts with its current state"
  return ExecutionGateway.ApprovalResponseFailure.make({ kind, message: failureMessage })
}

export const steeringFailure = (cause: Runtime.SteerError): ExecutionGateway.SteeringFailure =>
  ExecutionGateway.SteeringFailure.make({
    kind:
      cause._tag === "generalist/runtime/RunNotFound" ||
      cause._tag === "generalist/runtime/RunTerminal" ||
      cause._tag === "generalist/runtime/SteeringConflict"
        ? "rejected"
        : "unknown",
    message: message(cause),
  })

const prompt = (input: ExecutionGateway.StartTurn) =>
  input.promptParts === undefined || input.promptParts.length === 0
    ? input.prompt
    : [
        {
          role: "user" as const,
          content: input.promptParts.map((part) => {
            if (part.type === "text") return { type: "text" as const, text: part.text }
            if (part.filename === undefined)
              return { type: "file" as const, mediaType: part.mediaType, data: part.data }
            return { type: "file" as const, mediaType: part.mediaType, data: part.data, fileName: part.filename }
          }),
        },
      ]

export const runtimePrompt = (input: ExecutionGateway.StartTurn) => Prompt.make(prompt(input))
export const titlePrompt = (input: string) => Prompt.make(`Generate a title for this request:\n\n${input}`)

export const prepareFailure = (cause: unknown) =>
  ExecutionGateway.PrepareTurnFailure.make({
    kind: "invalid",
    message: message(cause),
  })

const isAdmitTurnFailure = Schema.is(ExecutionGateway.AdmitTurnFailure)

export const admitFailure = (cause: unknown) => {
  if (isAdmitTurnFailure(cause)) return cause
  let kind: ExecutionGateway.AdmitTurnFailure["kind"] = "invalid"
  if (Schema.is(Errors.IdempotencyConflict)(cause)) kind = "idempotency-conflict"
  else if (Schema.is(Errors.RunIdConflict)(cause)) kind = "run-id-conflict"
  else if (Schema.is(Errors.RuntimeUnavailable)(cause)) kind = "unavailable"
  return ExecutionGateway.AdmitTurnFailure.make({ kind, message: message(cause) })
}

const isActivateTurnFailure = Schema.is(ExecutionGateway.ActivateTurnFailure)

export const activateFailure = (cause: unknown) =>
  isActivateTurnFailure(cause)
    ? cause
    : ExecutionGateway.ActivateTurnFailure.make({
        kind: Schema.is(Errors.RunNotFound)(cause) ? "missing" : "unavailable",
        message: message(cause),
      })

export const status = (value: Run.RunStatus): Exclude<Status, "accepted"> => {
  switch (value) {
    case "queued":
      return "queued"
    case "waiting":
      return "waiting"
    case "succeeded":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "needs-resolution":
      return "waiting"
    case "cancelling":
      return "cancelling"
    case "running":
      return "running"
  }
}
