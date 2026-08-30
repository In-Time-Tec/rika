import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Effect, Exit, Stream } from "effect"
import { unitOrder } from "@rika/transcript/transcript-unit-order"

import { make } from "../../../src/thread/queue/root-owner"
import { settleInteractiveSubmission } from "../../../src/operation/interactive/turn/admission"
import { link, turn } from "./root-owner.fixture"

it.effect("does not accept a terminal projection while the durable parent run remains nonterminal", () =>
  Effect.gen(function* () {
    const completedProjection = {
      turn,
      units: [
        {
          key: "child:first",
          turnId: turn.id,
          order: unitOrder("child:first", 0),
          revision: 1,
          content: { _tag: "Entry" as const, role: "assistant" as const, text: "first child completed" },
        },
        {
          key: "child:second",
          turnId: turn.id,
          order: unitOrder("child:second", 1),
          revision: 1,
          content: { _tag: "Entry" as const, role: "assistant" as const, text: "second child completed" },
        },
      ],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed" as const,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "durable", state: "{}" },
      projectionVersion: 1,
    }
    let durableStatus: "waiting" | "completed" = "waiting"
    let starts = 0
    let promotions = 0
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(completedProjection),
        commitProjection: () => Effect.succeed("committed" as const),
      }),
      ExecutionGateway.Service.of({
        startTurn: () =>
          Effect.sync(() => {
            starts += 1
            return link
          }),
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: durableStatus, cursor: "durable" }),
      }),
    )

    const waiting = yield* owner.watchTurn(turn.id)
    expect(waiting.status).toBe("waiting")
    expect(waiting.units).toHaveLength(2)
    yield* settleInteractiveSubmission(
      {
        setTurnStatus: () => Effect.succeed(turn),
        settleThread: () => Effect.sync(() => (promotions += 1)),
        emit: () => undefined,
      },
      {
        thread: {
          id: turn.threadId,
          workspace: "/workspace",
          title: "thread",
          labels: [],
          pinned: false,
          archived: false,
          lineage: { _tag: "Original" },
          createdAt: 0,
          updatedAt: 0,
        },
        turn,
        outcome: Exit.succeed(waiting),
        dispatch: () => undefined,
      },
    )
    expect(promotions).toBe(0)
    expect(starts).toBe(0)

    durableStatus = "completed"
    const completed = yield* owner.watchTurn(turn.id)
    yield* settleInteractiveSubmission(
      {
        setTurnStatus: () => Effect.succeed(turn),
        settleThread: () => Effect.sync(() => (promotions += 1)),
        emit: () => undefined,
      },
      {
        thread: {
          id: turn.threadId,
          workspace: "/workspace",
          title: "thread",
          labels: [],
          pinned: false,
          archived: false,
          lineage: { _tag: "Original" },
          createdAt: 0,
          updatedAt: 0,
        },
        turn,
        outcome: Exit.succeed(completed),
        dispatch: () => undefined,
      },
    )
    expect(completed.status).toBe("completed")
    expect(promotions).toBe(1)
    expect(starts).toBe(0)
  }),
)
