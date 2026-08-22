import { Service } from "@rika/product/goal-repository"
export { Service }
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { RepositoryError } from "@rika/product/goal-repository"
import { Goal } from "@rika/product/goal-record"
import { GoalRow } from "./goal-row-codec"

const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })

const decode = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(GoalRow)(row)
    return yield* Schema.decodeUnknownEffect(Goal)({
      threadId: value.thread_id,
      objective: value.objective,
      status: value.status,
      budget: {
        ...(value.budget_tokens === null ? {} : { tokens: value.budget_tokens }),
        ...(value.budget_wall_clock_millis === null ? {} : { wallClockMillis: value.budget_wall_clock_millis }),
      },
      usage: {
        tokens: value.usage_tokens,
        elapsedMillis: value.usage_elapsed_millis,
        turns: value.usage_turns,
      },
      startedAtMillis: value.started_at,
      updatedAtMillis: value.updated_at,
      ...(value.completed_at === null ? {} : { completedAtMillis: value.completed_at }),
      ...(value.summary === null ? {} : { summary: value.summary }),
    })
  }).pipe(Effect.mapError(repositoryError))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("GoalRepository.get")(function* (threadId: string) {
      const rows = yield* sql`SELECT * FROM rika_goals WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(repositoryError),
      )
      return rows[0] === undefined ? undefined : yield* decode(rows[0])
    })
    const write = (goal: Goal, guardActive: boolean) => sql`INSERT INTO rika_goals
      (thread_id, objective, status, budget_tokens, budget_wall_clock_millis,
        usage_tokens, usage_elapsed_millis, usage_turns, started_at, updated_at, completed_at, summary)
      VALUES (${goal.threadId}, ${goal.objective}, ${goal.status}, ${goal.budget.tokens ?? null},
        ${goal.budget.wallClockMillis ?? null}, ${goal.usage.tokens}, ${goal.usage.elapsedMillis},
        ${goal.usage.turns}, ${goal.startedAtMillis}, ${goal.updatedAtMillis},
        ${goal.completedAtMillis ?? null}, ${goal.summary ?? null})
      ON CONFLICT(thread_id) DO UPDATE SET
        objective = excluded.objective,
        status = excluded.status,
        budget_tokens = excluded.budget_tokens,
        budget_wall_clock_millis = excluded.budget_wall_clock_millis,
        usage_tokens = excluded.usage_tokens,
        usage_elapsed_millis = excluded.usage_elapsed_millis,
        usage_turns = excluded.usage_turns,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        summary = excluded.summary
      WHERE ${guardActive ? 1 : 0} = 0 OR rika_goals.status <> 'active'
      RETURNING thread_id`
    return Service.of({
      get,
      claim: Effect.fn("GoalRepository.claim")(function* (goal) {
        const rows = yield* write(goal, true).pipe(Effect.mapError(repositoryError))
        return rows[0] === undefined ? undefined : yield* get(goal.threadId)
      }),
      replace: Effect.fn("GoalRepository.replace")(function* (goal) {
        yield* write(goal, false).pipe(Effect.mapError(repositoryError))
      }),
    })
  }),
)
