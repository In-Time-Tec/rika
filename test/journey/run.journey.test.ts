import { Database } from "bun:sqlite"
import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { run, runSignaled, runTest, sandbox } from "./process"

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

test(
  "packaged run and execute honor JSONL source order and selected threads",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const streamed = yield* run(context, ["run", "--stream-json", "--stream-json-input"], {
              input: '\n"first"\n  \n{"prompt":"second"}\n',
            })
            expect(streamed.exitCode, streamed.stderr).toBe(0)
            const events = streamed.stdout.split("\n").map((line) => Schema.decodeUnknownSync(EventJson)(line))
            expect(events.at(-1)?.type).toBe("execution.completed")

            const threads = Schema.decodeUnknownSync(ThreadsJson)((yield* run(context, ["threads", "list"])).stdout)
            expect(threads).toHaveLength(1)
            const selected = yield* run(
              context,
              ["-x", "--thread", threads[0]!.id, "--stream-json", "--stream-json-input", "argument-wins"],
              { input: "not-json\n" },
            )
            expect(selected.exitCode, selected.stderr).toBe(0)

            const database = new Database(context.env.RIKA_DATABASE!)
            const turns = database
              .query<
                { prompt: string; thread_id: string },
                []
              >("SELECT prompt, thread_id FROM rika_turns ORDER BY created_at")
              .all()
            database.close()
            expect(turns).toEqual([
              { prompt: "first second", thread_id: threads[0]!.id },
              { prompt: "argument-wins", thread_id: threads[0]!.id },
            ])
          }),
        (context) => context.dispose,
      ),
    ),
  30_000,
)

test(
  "packaged execute reports malformed physical lines and selection failures without a model request",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            const malformed = yield* run(context, ["--execute", "--stream-json", "--stream-json-input"], {
              input: '\n"valid"\n\nnot-json\n',
            })
            expect(malformed.exitCode).not.toBe(0)
            expect(`${malformed.stdout}\n${malformed.stderr}`).toContain("Invalid JSON on stdin line 4")

            const missing = yield* run(context, ["run", "--thread", "missing-thread", "never dispatched"])
            expect(missing.exitCode).not.toBe(0)
            expect(`${missing.stdout}\n${missing.stderr}`).toContain("Thread missing-thread does not exist")
          }),
        (context) => context.dispose,
      ),
    ),
  20_000,
)

test(
  "SIGINT stops a packaged noninteractive client cleanly",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
              { parts: [{ type: "text", text: "should not reach the interrupted client" }], delayMs: 5_000 },
            ])
            expect(Number(yield* runSignaled(context, ["run", "interrupt me"], "SIGINT"))).toBe(0)
          }),
        (context) => context.dispose,
      ),
    ),
  20_000,
)
