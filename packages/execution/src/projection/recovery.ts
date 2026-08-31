import type { Block } from "@rika/product/execution-transcript-contract"
import { Cell as GeneralistCell } from "generalist/repl"
import type { RunEvent } from "generalist/runtime"
import { Option, Schema } from "effect"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
export type CellNotice = Cell["notices"][number]
type ToolProgressData = Extract<RunEvent.RunEvent, { readonly _tag: "ToolProgress" }>["data"]

export const cellExecutionFailedTag = "generalist/repl/CellExecutionFailed"
export const kernelUnavailableTag = "generalist/repl/KernelUnavailable"
export const kernelProtocolViolationTag = "generalist/repl/KernelProtocolViolation"
export const cellOutcomeUnknownTag = "generalist/repl/CellOutcomeUnknown"

export const eventNotice = (data: ToolProgressData): CellNotice | undefined => {
  const decoded = Schema.decodeUnknownOption(GeneralistCell.CellEvent)(data)
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

export const restartNotification = (
  data: ToolProgressData,
): { readonly title: string; readonly detail: string } | undefined => {
  const decoded = Schema.decodeUnknownOption(GeneralistCell.KernelRestarted)(data)
  return Option.isSome(decoded)
    ? {
        title: "Kernel restarted",
        detail: `The TypeScript kernel restarted (${decoded.value.reason}); bindings from earlier cells may be gone.`,
      }
    : undefined
}
