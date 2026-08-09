import type { Block } from "@rika/product/execution-transcript-contract"
import { bounded, cellTextLimit, optionalString, record, string } from "./baton-projector-values"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
export type CellNotice = Cell["notices"][number]

export const cellExecutionFailedTag = "@batonfx/repl/CellExecutionFailed"
export const kernelUnavailableTag = "@batonfx/repl/KernelUnavailable"
export const kernelProtocolViolationTag = "@batonfx/repl/KernelProtocolViolation"
export const cellOutcomeUnknownTag = "@batonfx/repl/CellOutcomeUnknown"

const names = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const nameList = (value: unknown): string => names(value).join(", ")

export const eventNotice = (event: Readonly<Record<string, unknown>>): CellNotice | undefined => {
  switch (event._tag) {
    case "KernelStarting":
      return { kind: "starting", detail: "Starting the kernel." }
    case "KernelReady":
      return { kind: "ready", detail: `Kernel ready at profile ${optionalString(event.profileDigest)}.` }
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

export interface CellOutcome {
  readonly status: Cell["status"]
  readonly error?: NonNullable<Cell["error"]>
  readonly diagnostic?: { readonly title: string; readonly detail: string; readonly recoverable: boolean }
}

export const failureOutcome = (failure: unknown): CellOutcome => {
  const value = record(failure)
  const message = optionalString(value.message)
  switch (value._tag) {
    case cellExecutionFailedTag:
      return {
        status: "failed",
        error: {
          name: string(value.name, "Error"),
          message: bounded(message, cellTextLimit),
          ...(typeof value.stack === "string" ? { stack: bounded(value.stack, cellTextLimit) } : {}),
        },
      }
    case kernelUnavailableTag:
      return {
        status: "failed",
        diagnostic: {
          title: "Kernel unavailable",
          detail: `No kernel ran the cell (${string(value.reason, "unknown")}). ${message}`.trim(),
          recoverable: false,
        },
      }
    case kernelProtocolViolationTag:
      return {
        status: "failed",
        diagnostic: {
          title: "Kernel protocol violation",
          detail: message.length === 0 ? "The kernel broke the cell protocol." : message,
          recoverable: false,
        },
      }
    case cellOutcomeUnknownTag:
      return {
        status: "unknown",
        diagnostic: {
          title: "Cell outcome unknown",
          detail:
            `The cell may or may not have committed its effects (${string(value.reason, "unknown")}). ${message} Resolve it explicitly; it is never replayed.`.trim(),
          recoverable: true,
        },
      }
    default:
      return {
        status: "failed",
        error: { name: "Error", message: bounded(message.length === 0 ? "The cell failed." : message, cellTextLimit) },
      }
  }
}
