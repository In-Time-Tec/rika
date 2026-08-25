import { Service } from "@rika/product/goal-repository"
export { Service }
import { eq, ne } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer, Schema } from "effect"
import { RepositoryError } from "@rika/product/goal-repository"
import { Goal } from "@rika/product/goal-record"
import { rikaGoals } from "../database/schema/product"

const repositoryError = (error: { readonly message: string }) => RepositoryError.make({ message: error.message })

const decode = (row: typeof rikaGoals.$inferSelect) =>
  Effect.gen(function* () {
    const value = row
    let budget: Goal["budget"]
    if (value.budgetTokens === null)
      budget =
        value.budgetWallClockMillis === null ? {} : { wallClockMillis: value.budgetWallClockMillis }
    else
      budget =
        value.budgetWallClockMillis === null
          ? { tokens: value.budgetTokens }
          : { tokens: value.budgetTokens, wallClockMillis: value.budgetWallClockMillis }
    const goal = {
      threadId: value.threadId,
      objective: value.objective,
      status: value.status,
      budget,
      usage: {
        tokens: value.usageTokens,
        elapsedMillis: value.usageElapsedMillis,
        turns: value.usageTurns,
      },
      startedAtMillis: value.startedAt,
      updatedAtMillis: value.updatedAt,
    }
    if (value.completedAt === null)
      return yield* Schema.decodeUnknownEffect(Goal)(
        value.summary === null ? goal : { ...goal, summary: value.summary },
      )
    return yield* Schema.decodeUnknownEffect(Goal)(
      value.summary === null
        ? { ...goal, completedAtMillis: value.completedAt }
        : { ...goal, completedAtMillis: value.completedAt, summary: value.summary },
    )
  }).pipe(Effect.mapError(repositoryError))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults()
    const get = Effect.fn("GoalRepository.get")(function* (threadId: string) {
      const rows = yield* db.select().from(rikaGoals).where(eq(rikaGoals.threadId, threadId)).pipe(
        Effect.mapError(repositoryError),
      )
      return rows[0] === undefined ? undefined : yield* decode(rows[0])
    })
    const write = (goal: Goal, guardActive: boolean) => {
      const values = {
        threadId: goal.threadId, objective: goal.objective, status: goal.status,
        budgetTokens: goal.budget.tokens ?? null, budgetWallClockMillis: goal.budget.wallClockMillis ?? null,
        usageTokens: goal.usage.tokens, usageElapsedMillis: goal.usage.elapsedMillis, usageTurns: goal.usage.turns,
        startedAt: goal.startedAtMillis, updatedAt: goal.updatedAtMillis,
        completedAt: goal.completedAtMillis ?? null, summary: goal.summary ?? null,
      }
      const conflict = {
        target: rikaGoals.threadId,
        set: values,
      }
      return db.insert(rikaGoals).values(values).onConflictDoUpdate(
        guardActive ? { ...conflict, setWhere: ne(rikaGoals.status, "active") } : conflict,
      ).returning({ threadId: rikaGoals.threadId })
    }
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
