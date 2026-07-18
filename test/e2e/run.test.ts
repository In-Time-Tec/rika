import { Database } from "bun:sqlite"
import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { run, runTest, sandbox } from "./process"

const ThreadsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })))
const EventJson = Schema.fromJsonString(Schema.Struct({ type: Schema.String }))

test(
  "packaged deterministic execution persists thread and turn cursors",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            expect((yield* run(context, ["run", "hello"])).stdout).toContain("deterministic response")
            const threads = Schema.decodeUnknownSync(ThreadsJson)((yield* run(context, ["threads", "list"])).stdout)
            expect(threads).toHaveLength(1)
            const events = (yield* run(context, ["run", "--thread", threads[0]!.id, "--stream-json", "second"])).stdout
              .split("\n")
              .map((line) => Schema.decodeUnknownSync(EventJson)(line))
            expect(events.map((event) => event.type)).toContain("model.output.completed")
            expect(events.map((event) => event.type)).toContain("execution.completed")
            const database = new Database(context.env.RIKA_DATABASE!)
            const turns = database
              .query<
                { status: string; last_cursor: string | null },
                []
              >("SELECT status, last_cursor FROM rika_turns ORDER BY created_at")
              .all()
            database.close()
            expect(turns).toHaveLength(2)
            expect(turns.every((turn) => turn.status === "completed" && typeof turn.last_cursor === "string")).toBe(
              true,
            )
          }),
        (context) => context.dispose,
      ),
    ),
  20_000,
)

test(
  "packaged normal prompt registers the non-empty tool catalog with Crypto",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const result = yield* run(context, ["run", "--ephemeral", "say hi"])
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("deterministic response")
            expect(result.stderr).not.toContain("TypeError: members.map is not a function")
            expect(result.stderr).not.toContain("Tool input schema digest computation requires Crypto")
            expect(result.stderr).not.toContain("Tool input schema digest validation requires Crypto")
          }),
        (context) => context.dispose,
      ),
    ),
  20_000,
)
