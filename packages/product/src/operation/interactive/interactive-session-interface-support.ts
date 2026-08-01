import * as ExecutionEvent from "@rika/product/execution-event"

export const agentResponseArrived = (events: ReadonlyArray<ExecutionEvent.Event>): boolean => {
  for (const event of events) {
    if (event.type === "execution.cancelled") return false
    if (
      event.type.includes("reasoning") ||
      event.type === "model.output.delta" ||
      event.type === "model.cycle.completed" ||
      event.type === "model.output.completed" ||
      event.type === "model.toolcall.delta" ||
      event.type === "tool.call.requested" ||
      event.type === "child_run.spawned"
    )
      return true
  }
  return false
}
