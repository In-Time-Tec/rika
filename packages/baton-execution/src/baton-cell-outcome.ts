import type { Block } from "@rika/product/execution-transcript-contract"
import { bounded, optionalString, record, string } from "./baton-projector-values"
import { cellTextLimit } from "./baton-cell-projection"
import {
  cellExecutionFailedTag,
  cellOutcomeUnknownTag,
  kernelProtocolViolationTag,
  kernelUnavailableTag,
} from "./baton-recovery-projection"

type Cell = Extract<Block, { readonly _tag: "Cell" }>

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
