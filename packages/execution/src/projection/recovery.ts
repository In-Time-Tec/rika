import type { Block } from "@rika/product/execution-transcript-contract"
import { optionalString, record, string } from "./values"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
export type CellNotice = Cell["notices"][number]

export const cellExecutionFailedTag = "tenetkit/repl/CellExecutionFailed"
export const kernelUnavailableTag = "tenetkit/repl/KernelUnavailable"
export const kernelProtocolViolationTag = "tenetkit/repl/KernelProtocolViolation"
export const cellOutcomeUnknownTag = "tenetkit/repl/CellOutcomeUnknown"

const names = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const nameList = (value: unknown): string => names(value).join(", ")

export const eventNotice = (event: Readonly<Record<string, unknown>>): CellNotice | undefined => {
  switch (event._tag) {
    case "KernelStarting":
      return { kind: "starting", detail: "Starting the kernel." }
    case "KernelRestarted":
      return {
        kind: "restarted",
        detail: `Kernel restarted (${string(event.reason, "unknown")}) at epoch ${
          typeof event.epoch === "number" ? event.epoch : "unknown"
        }.`,
      }
    case "StateRestored": {
      const restored = nameList(event.names)
      return {
        kind: "restored",
        detail: restored.length === 0 ? "No bindings were restored." : `Restored ${restored}.`,
      }
    }
    case "StateLost": {
      const dropped = nameList(event.droppedNames)
      return {
        kind: "lost",
        detail: `Lost ${dropped.length === 0 ? "bindings" : dropped} (${string(event.reason, "unknown")}).`,
      }
    }
    default:
      return undefined
  }
}

export const nestedOperationNotice = (data: Readonly<Record<string, unknown>>): CellNotice | undefined => {
  const nested = record(data.nestedOperation)
  const kind = optionalString(nested.kind)
  const status = optionalString(nested.status)
  if (kind.length === 0 || status.length === 0) return undefined
  return { kind: "activity", detail: `${kind} ${status}` }
}

export const restartNotification = (
  event: Readonly<Record<string, unknown>>,
): { readonly title: string; readonly detail: string } | undefined =>
  event._tag === "KernelRestarted"
    ? {
        title: "Kernel restarted",
        detail: `The TypeScript kernel restarted (${string(event.reason, "unknown")}); bindings from earlier cells may be gone.`,
      }
    : undefined
