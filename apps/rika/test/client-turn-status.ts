import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { Cause, Effect } from "effect"
import { waitUntil } from "./client-process-test-runtime"

const turnStatus = Effect.fn("ClientMainTest.turnStatus")(function* (database: string, prompt: string) {
  const reactivity = yield* Reactivity.make
  const client = yield* SqliteClient.make({ filename: database, readonly: true }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
  )
  const rows = yield* client<{ readonly status: string }>`SELECT status FROM rika_turns WHERE prompt = ${prompt}`
  return rows[0]?.status
})

export const awaitTurnStatus = Effect.fn("ClientMainTest.awaitTurnStatus")(function* (
  database: string,
  prompt: string,
  status: string,
  timeout = 30_000,
) {
  let observed = "unread"
  yield* waitUntil(
    Effect.gen(function* () {
      observed = yield* turnStatus(database, prompt).pipe(
        Effect.map((value) => value ?? "absent"),
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      )
      return observed === status
    }).pipe(Effect.scoped),
    timeout,
  ).pipe(
    Effect.catchCause(() =>
      Effect.die(`turn "${prompt}" settled as ${observed} instead of ${status} within ${timeout}ms`),
    ),
  )
})
