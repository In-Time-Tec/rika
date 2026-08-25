import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { make } from "../src/execution/lifecycle/execution-authority-reconciliation"

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
    const turns = {
      listNonterminal: Effect.succeed([turn]),
      listSteeringAdmissions: Effect.succeed([]),
    } as unknown as TurnRepository.Interface
    const result = yield* make({
      turns,
      backend: {} as ExecutionGateway.Interface,
      setTurnStatus: () => Effect.die("missing execution evidence settled the Turn"),
    })

    expect(result.active).toEqual([])
    expect(result.settledThreads).toEqual([])
  }),
)

it.effect("settles a Turn from terminal execution authority without consulting transcript projection", () =>
  Effect.gen(function* () {
    const linked: Turn.AgentExecutionTurn = {
      ...turn,
      executionLink: { runId: "terminal-run", threadId: turn.threadId, turnId: turn.id },
    }
    let settled: Turn.AgentExecutionTurn | undefined
    const result = yield* make({
      turns: {
        listNonterminal: Effect.succeed([linked]),
        listSteeringAdmissions: Effect.succeed([]),
      } as unknown as TurnRepository.Interface,
      backend: {
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "terminal" }),
      } as unknown as ExecutionGateway.Interface,
      setTurnStatus: (_id, status, now) =>
        Effect.sync(() => {
          settled = { ...linked, status, updatedAt: now }
          return settled
        }),
    })

    expect(result.active).toEqual([])
    expect(result.settledThreads).toEqual([turn.threadId])
    expect(settled).toMatchObject({ status: "completed" })
  }),
)
