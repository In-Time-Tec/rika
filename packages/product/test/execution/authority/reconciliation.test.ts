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
