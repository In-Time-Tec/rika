import { afterAll, beforeAll, expect, test } from "vitest"
import { Effect, FileSystem, Schema } from "effect"
import { command, run, runTest, sandbox, type Sandbox } from "./process"

const ReviewJson = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    lanes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: Schema.String,
        output: Schema.String,
      }),
    ),
  }),
)

let context: Sandbox

beforeAll(() =>
  runTest(
    Effect.gen(function* () {
      context = yield* sandbox
      const fileSystem = yield* FileSystem.FileSystem
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "rika@example.test"],
        ["config", "user.name", "Rika Test"],
      ])
        expect(yield* command("git", args, { cwd: context.workspace })).toBe(0)
      yield* fileSystem.writeFileString(`${context.workspace}/review.txt`, "before\n")
      expect(yield* command("git", ["add", "review.txt"], { cwd: context.workspace })).toBe(0)
      expect(yield* command("git", ["commit", "-qm", "base"], { cwd: context.workspace })).toBe(0)
    }),
  ),
)

afterAll(() => runTest(context.dispose))

test(
  "packaged review runs durable lanes with stable text and JSON output",
  () =>
    runTest(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const output = { summary: "deterministic response", findings: [] }
        context.env.RIKA_TEST_MODEL_SCRIPT = Schema.encodeSync(Schema.UnknownFromJsonString)([
          ...Array.from({ length: 3 }, () => ({ parts: [{ type: "text", text: "deterministic response" }] })),
          ...Array.from({ length: 3 }, () => ({ object: output })),
          ...Array.from({ length: 3 }, () => ({ parts: [{ type: "text", text: "deterministic response" }] })),
          ...Array.from({ length: 3 }, () => ({ object: output })),
        ])
        delete context.env.RIKA_TEST_MODEL_RESPONSE
        expect((yield* run(context, ["review"])).stdout).toBe("No changes to review.")
        yield* fileSystem.writeFileString(`${context.workspace}/review.txt`, "after\n")
        const text = yield* run(context, ["review", "review.txt"], { timeout: 60_000 })
        const laneOutput = `deterministic response${Schema.encodeSync(Schema.UnknownFromJsonString)({ type: "structured", value: output, schema_ref: "rika.agent.review.v1" })}`
        expect(text.exitCode).toBe(0)
        expect(text.stdout).toContain(`## correctness\n${laneOutput}`)
        expect(text.stdout).toContain(`## security\n${laneOutput}`)
        expect(text.stdout).toContain(`## quality\n${laneOutput}`)
        expect(yield* command("git", ["add", "review.txt"], { cwd: context.workspace })).toBe(0)
        const json = yield* run(context, ["review", "--staged", "--json"], { timeout: 60_000 })
        expect(json.exitCode).toBe(0)
        expect(Schema.decodeUnknownSync(ReviewJson)(json.stdout)).toMatchObject({
          status: "satisfied",
          lanes: [
            { id: "correctness", status: "completed", output: laneOutput },
            { id: "security", status: "completed", output: laneOutput },
            { id: "quality", status: "completed", output: laneOutput },
          ],
        })
      }),
    ),
  130_000,
)
