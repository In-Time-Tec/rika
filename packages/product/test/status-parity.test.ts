import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionChildRun from "@rika/product/execution-child-run"
import { Event as DirectEvent } from "@rika/product/execution-event"
import { Status as DirectStatus } from "@rika/product/execution-status"
import { AgentProfile as DirectAgentProfile } from "@rika/product/execution-child-run"
import * as ExecutionStatus from "@rika/product/execution-status"
import { describe, expect, it } from "vitest"

const members = (schema: { readonly ast: { readonly types?: ReadonlyArray<{ readonly literal?: unknown }> } }) =>
  (schema.ast.types ?? []).map((type) => type.literal)

describe("execution status parity", () => {
  it("keeps every Status vocabulary identical", () => {
    expect(members(ExecutionStatus.Status as never)).toEqual([...ExecutionStatus.statuses])
    expect(ExecutionStatus.Status).toBe(DirectStatus)
    expect(ExecutionEvent.Event).toBe(DirectEvent)
    expect(ExecutionChildRun.AgentProfile).toBe(DirectAgentProfile)
  })

  it("classifies every status exactly once", () => {
    for (const status of ExecutionStatus.statuses) {
      const terminal = ExecutionStatus.isTerminalStatus(status)
      const active = ExecutionStatus.isActiveStatus(status)
      expect(terminal && active).toBe(false)
      expect(ExecutionStatus.occupiesQueue(status)).toBe(!terminal)
    }
    expect(ExecutionStatus.statuses.filter(ExecutionStatus.isTerminalStatus)).toEqual([
      ...ExecutionStatus.terminalStatuses,
    ])
    expect(ExecutionStatus.statuses.filter(ExecutionStatus.isActiveStatus)).toEqual(["accepted", "running", "waiting"])
  })

  it("maps terminal event types onto statuses", () => {
    expect(ExecutionStatus.terminalEventStatus("execution.completed")).toBe("completed")
    expect(ExecutionStatus.terminalEventStatus("execution.failed")).toBe("failed")
    expect(ExecutionStatus.terminalEventStatus("execution.cancelled")).toBe("cancelled")
    expect(ExecutionStatus.terminalEventStatus("execution.started")).toBeUndefined()
    for (const status of ExecutionStatus.terminalStatuses)
      expect(ExecutionStatus.terminalEventStatus(`execution.${status}`)).toBe(status)
  })
})
