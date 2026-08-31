import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { make } from "../../../src/execution/authority/reconciliation"

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("zombie"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "running",
  createdAt: 1,
  updatedAt: 2,
}

it.effect("leaves a link-less nonterminal Turn blocked without inventing a terminal outcome", () =>
  Effect.gen(function* () {
    const turns = TurnRepository.Service.of({
      listNonterminal: Effect.succeed([turn]),
      listSteeringAdmissions: Effect.succeed([]),
    })
    const result = yield* make({
      turns,
      backend: ExecutionGateway.makeTest(),
      setTurnStatus: () => Effect.die("missing execution evidence settled the Turn"),
    })

    expect(result.active).toEqual([])
    expect(result.settledThreads).toEqual([])
  }),
)

it.effect("fails a linked nonterminal Turn when its persisted Run is unavailable", () =>
  Effect.gen(function* () {
    const linked = {
      ...turn,
      executionLink: { runId: "archived-run", threadId: turn.threadId, turnId: turn.id },
    }
    const settled = new Array<{ readonly status: string; readonly now: number }>()
    const result = yield* make({
      turns: TurnRepository.Service.of({
        listNonterminal: Effect.succeed([linked]),
        listSteeringAdmissions: Effect.succeed([]),
      }),
      backend: ExecutionGateway.makeTest({
        inspectTurn: () => Effect.succeed({ status: "unavailable" }),
      }),
      setTurnStatus: (_id, status, now) =>
        Effect.sync(() => {
          settled.push({ status, now })
          return { ...linked, status, updatedAt: now }
        }),
    })

    expect(settled).toEqual([expect.objectContaining({ status: "failed" })])
    expect(result.active).toEqual([])
    expect(result.settledThreads).toEqual([turn.threadId])
  }),
)
