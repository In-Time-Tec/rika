import { Function } from "effect"
import type { Presentation, Projection, Unit } from "./schema"
import { identityKey, scopedIdentity } from "./unit-identity"
import { unitOrder } from "./unit-order"

export interface RunningRecordedShell {
  readonly id: string
  readonly command: string
  readonly status: "running"
}

export interface RecordedShellTerminalResult {
  readonly text: string
  readonly truncated: boolean
  readonly exitCode?: number | undefined
}

export interface TerminalRecordedShell {
  readonly id: string
  readonly command: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly result: RecordedShellTerminalResult
}

const presentation: Presentation = {
  family: "shell",
  action: "command",
  activeLabel: "Running",
  completeLabel: "Ran",
  outputDisplay: "inline",
}

const keyFor = (turnId: string): string => identityKey("tool", turnId, "recorded-shell")

const runningUnit = (turn: RunningRecordedShell): Unit => {
  const key = keyFor(turn.id)
  return {
    key,
    turnId: turn.id,
    order: unitOrder(key, 0),
    revision: 0,
    content: {
      _tag: "Block",
      block: {
        _tag: "ToolCall",
        id: scopedIdentity(turn.id, "recorded-shell"),
        name: "bash",
        input: JSON.stringify({ command: turn.command }),
        status: "running",
        presentation,
        detail: turn.command,
        files: [],
      },
    },
  }
}

export const recordedShellProjection = (turn: RunningRecordedShell): Projection => ({
  revision: 0,
  modelPhase: -1,
  units: [runningUnit(turn)],
})

const terminalStatus = (status: TerminalRecordedShell["status"]): "complete" | "failed" | "cancelled" =>
  status === "completed" ? "complete" : status

export const settleRecordedShellProjection: {
  (projection: Projection, turn: TerminalRecordedShell): Projection
  (turn: TerminalRecordedShell): (projection: Projection) => Projection
} = Function.dual(2, (projection: Projection, turn: TerminalRecordedShell): Projection => {
  const expected = runningUnit({ id: turn.id, command: turn.command, status: "running" })
  const current = projection.units.find((unit) => unit.key === expected.key)
  const identity = current?.content._tag === "Block" && current.content.block._tag === "ToolCall" ? current : expected
  return {
    revision: 1,
    modelPhase: -1,
    units: [
      {
        key: identity.key,
        turnId: identity.turnId,
        order: identity.order,
        revision: 1,
        content: {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            id:
              identity.content._tag === "Block" && identity.content.block._tag === "ToolCall"
                ? identity.content.block.id
                : scopedIdentity(turn.id, "recorded-shell"),
            name: "bash",
            input: JSON.stringify({ command: turn.command }),
            status: terminalStatus(turn.status),
            presentation,
            detail: turn.command,
            output: turn.result.text,
            process: {
              truncated: turn.result.truncated,
              ...(turn.result.exitCode === undefined ? {} : { exitCode: turn.result.exitCode }),
            },
            files: [],
          },
        },
      },
    ],
  }
})
