import { Content } from "@relayfx/sdk"
import type { ChildOrchestration, Execution, Workflow } from "@relayfx/sdk"
import { Schema } from "effect"
import type { PromptPart } from "@rika/product/execution-request"
import { ExecutionId } from "@rika/product/execution-identifier"
import { BackendError } from "@rika/product/execution-service"
import * as DataBlobStore from "../../data-blob-store"
import { childIdFromExecutionId } from "./relay-execution-id-codec"
import { attachedWorkflow, standaloneWorkflow } from "./relay-execution-workflow-id"
import { workflowDefinitionName } from "../relay-workflow-compiler"

export const childExecutionIdFromEvent = (item: Execution.ExecutionEvent) => {
  const value = item.child_execution_id ?? item.data?.child_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const error = (cause: unknown) =>
  Schema.is(BackendError)(cause) ? cause : BackendError.make({ message: String(cause) })

export const executionInput = (input: {
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
}) => {
  if (input.promptParts === undefined) return [Content.text(input.prompt)]
  const parts: Array<ReturnType<typeof Content.text> | ReturnType<typeof DataBlobStore.reference>> = []
  let pendingText: string | undefined
  const flushText = () => {
    if (pendingText === undefined) return
    parts.push(Content.text(pendingText))
    pendingText = undefined
  }
  for (const part of input.promptParts) {
    if (part.type === "text") {
      pendingText = (pendingText ?? "") + part.text
      continue
    }
    flushText()
    parts.push(DataBlobStore.reference(part.mediaType, part.data, part.filename))
  }
  flushText()
  return parts
}

export const mapFanOut = (value: ChildOrchestration.FanOutState) => {
  const parentTurnId = ExecutionId.executionKey(String(value.parent_execution_id))
  return {
    fanOutId: String(value.fan_out_id),
    parentTurnId,
    state: value.state,
    maxConcurrency: value.max_concurrency,
    join: value.join._tag,
    members: value.members.map((member) => ({
      childId: childIdFromExecutionId({ parentTurnId, value: member.child_execution_id }),
      ordinal: member.ordinal,
      state: member.state,
      ...(member.output === undefined
        ? {}
        : {
            output: Array.isArray(member.output)
              ? member.output.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("")
              : member.output,
          }),
      ...(member.error === undefined ? {} : { error: member.error }),
    })),
  }
}

export const workflow = (value: Workflow.RunRecord) => {
  const execution = String(value.execution_id)
  const attached = attachedWorkflow(execution)
  const standalone = standaloneWorkflow(execution)
  return {
    runId: attached?.runId ?? standalone?.runId ?? execution.replace(/^workflow:/, ""),
    ...(attached === undefined ? {} : { ownerTurnId: attached.ownerTurnId }),
    workflow: workflowDefinitionName(String(value.pin.workflow_definition_id)),
    revision: value.pin.workflow_definition_revision,
    digest: value.pin.workflow_definition_digest,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}
