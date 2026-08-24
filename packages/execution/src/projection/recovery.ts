import type { Block } from "@rika/product/execution-transcript-contract"
import { Cell as TenetCell } from "tenetkit/repl"
import type { RunEvent } from "tenetkit/runtime"
import { Option, Schema } from "effect"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
export type CellNotice = Cell["notices"][number]
type ToolProgressData = Extract<RunEvent.RunEvent, { readonly _tag: "ToolProgress" }>["data"]

export const cellExecutionFailedTag = "tenetkit/repl/CellExecutionFailed"
export const kernelUnavailableTag = "tenetkit/repl/KernelUnavailable"
export const kernelProtocolViolationTag = "tenetkit/repl/KernelProtocolViolation"
export const cellOutcomeUnknownTag = "tenetkit/repl/CellOutcomeUnknown"

export const eventNotice = (data: ToolProgressData): CellNotice | undefined => {
  const decoded = Schema.decodeUnknownOption(TenetCell.CellEvent)(data)
  if (Option.isNone(decoded)) return undefined
  const event = decoded.value
  switch (event._tag) {
    case "KernelStarting":
      return { kind: "starting", detail: "Starting the kernel." }
    case "KernelRestarted":
      return {
        kind: "restarted",
        detail: `Kernel restarted (${event.reason}) at epoch ${event.epoch}.`,
      }
    case "StateRestored": {
      const restored = event.names.join(", ")
      return {
        kind: "restored",
        detail: restored.length === 0 ? "No bindings were restored." : `Restored ${restored}.`,
      }
    }
    case "StateLost": {
      const dropped = event.droppedNames.join(", ")
      return {
        kind: "lost",
        detail: `Lost ${dropped.length === 0 ? "bindings" : dropped} (${event.reason}).`,
      }
    }
    default:
      return undefined
  }
}

const NestedOperationProgress = Schema.Struct({
  nestedOperation: Schema.Struct({ kind: Schema.String, status: Schema.String }),
})

export const nestedOperationNotice = (data: ToolProgressData): CellNotice | undefined => {
  const decoded = Schema.decodeUnknownOption(NestedOperationProgress)(data)
  return Option.isSome(decoded)
    ? { kind: "activity", detail: `${decoded.value.nestedOperation.kind} ${decoded.value.nestedOperation.status}` }
    : undefined
}

export const restartNotification = (
  data: ToolProgressData,
): { readonly title: string; readonly detail: string } | undefined => {
  const decoded = Schema.decodeUnknownOption(TenetCell.KernelRestarted)(data)
  return Option.isSome(decoded)
    ? {
        title: "Kernel restarted",
        detail: `The TypeScript kernel restarted (${decoded.value.reason}); bindings from earlier cells may be gone.`,
      }
    : undefined
}
