import type { Block } from "@rika/product/execution-transcript-contract"
import { Cell as TenetCell } from "tenetkit/repl"
import { optionalString } from "../values"
import {
  cellExecutionFailedTag,
  cellOutcomeUnknownTag,
  kernelProtocolViolationTag,
  kernelUnavailableTag,
} from "../recovery"

type Cell = Extract<Block, { readonly _tag: "Cell" }>

const filteredStack = (stack: string): string | undefined => {
  const lines = stack
    .split("\n")
    .filter((line) => !line.includes("$bunfs") && !line.includes("/effect/") && !line.includes("effect@"))
  const value = lines.join("\n").trim()
  return value.length === 0 ? undefined : value
}

export interface CellOutcome {
  readonly status: Cell["status"]
  readonly error?: NonNullable<Cell["error"]>
  readonly diagnostic?: { readonly title: string; readonly detail: string; readonly recoverable: boolean }
}

export const failureOutcome = (failure: TenetCell.CellFailure): CellOutcome => {
  const message = optionalString(failure.message)
  switch (failure._tag) {
    case cellExecutionFailedTag: {
      const stack = filteredStack(optionalString(failure.stack))
      let cellError: NonNullable<Cell["error"]> = {
        name: failure.name,
        message,
      }
      if (stack !== undefined) cellError = { ...cellError, stack }
      return {
        status: "failed",
        error: cellError,
      }
    }
    case kernelUnavailableTag:
      return {
        status: "failed",
        diagnostic: {
          title: "Kernel unavailable",
          detail: `No kernel ran the cell (${failure.reason}). ${message}`.trim(),
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
            `The cell may or may not have committed its effects (${failure.reason}). ${message} Resolve it explicitly; it is never replayed.`.trim(),
          recoverable: true,
        },
      }
    default:
      return {
        status: "failed",
        error: { name: "Error", message: message.length === 0 ? "The cell failed." : message },
      }
  }
}
