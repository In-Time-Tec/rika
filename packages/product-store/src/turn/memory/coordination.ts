import { Effect } from "effect"

import { AgentExecutionTurn, RecordedShellTurn } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn } from "@rika/product/thread-result"
import type { Interface } from "@rika/product/turn-repository"
import { isTerminalStatus } from "@rika/product/execution-status"

export { isTerminalStatus }
const coordinators = new WeakMap<Interface, MemoryCoordinator>()

type TerminalStatus = "completed" | "failed" | "cancelled"
export type MemoryRefoldWrite<A> = { readonly _tag: "Commit"; readonly value: A } | { readonly _tag: "Stale" }
type MemoryRefoldResult<A> =
  | { readonly _tag: "Committed"; readonly turn: AgentExecutionTurn; readonly value: A }
  | { readonly _tag: "Stale" }

export interface MemoryCoordinator {
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly agentExecutions: Effect.Effect<ReadonlyArray<AgentExecutionTurn>>
  readonly adoptRefold: <A>(
    expected: Pick<AgentExecutionTurn, "id" | "status">,
    status: TerminalStatus,
    write: (turn: AgentExecutionTurn) => Effect.Effect<MemoryRefoldWrite<A>>,
  ) => Effect.Effect<MemoryRefoldResult<A>>
  readonly writeRecordedShell: <A>(
    expected: RunningRecordedShellTurn | undefined,
    turn: RecordedShellTurn,
    write: (turn: RecordedShellTurn) => Effect.Effect<MemoryRefoldWrite<A>>,
  ) => Effect.Effect<MemoryRefoldWrite<{ readonly turn: RecordedShellTurn; readonly value: A }>>
}

export const MemoryCoordination = {
  register(coordinator: MemoryCoordinator, repository: Interface): void {
    coordinators.set(repository, coordinator)
  },
}

export const memoryCoordinator = (repository: Interface): MemoryCoordinator | undefined => coordinators.get(repository)
