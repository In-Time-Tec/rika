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
      yield* fileSystem.writeFileString(`${context.workspace}/excluded.txt`, "before\n")
      expect(yield* command("git", ["add", "review.txt", "excluded.txt"], { cwd: context.workspace })).toBe(0)
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
        const reviewRound = () => [
          ...Array.from({ length: 3 }, () => ({
            parts: [{ type: "text", text: "deterministic response" }],
            delayMs: 100,
          })),
          ...Array.from({ length: 3 }, () => ({ object: output })),
        ]
        context.env.RIKA_TEST_MODEL_SCRIPT = Schema.encodeSync(Schema.UnknownFromJsonString)(
          Array.from({ length: 4 }, reviewRound).flat(),
        )
        delete context.env.RIKA_TEST_MODEL_RESPONSE
        const review = (args: ReadonlyArray<string> = [], timeout?: number) =>
          run(context, ["review", ...args], timeout === undefined ? {} : { timeout })
        const noChanges = yield* review()
        expect(noChanges.exitCode, noChanges.stderr).toBe(0)
        expect(noChanges.stdout).toBe("No changes to review.")
        expect((yield* review(["--json"])).stdout).toBe('{"status":"no-changes","findings":[]}')
        yield* fileSystem.writeFileString(`${context.workspace}/excluded.txt`, "after\n")
        expect((yield* review(["review.txt"])).stdout).toBe("No changes to review.")
        yield* fileSystem.writeFileString(`${context.workspace}/review.txt`, "after\n")
        const text = yield* review(["review.txt"], 60_000)
        const laneOutput = `deterministic response${Schema.encodeSync(Schema.UnknownFromJsonString)({ type: "structured", value: output, schema_ref: "rika.agent.review.v1" })}`
        expect(text.exitCode).toBe(0)
        expect(text.stdout).toContain(`## correctness\n${laneOutput}`)
        expect(text.stdout).toContain(`## security\n${laneOutput}`)
        expect(text.stdout).toContain(`## quality\n${laneOutput}`)
        expect(yield* command("git", ["add", "review.txt", "excluded.txt"], { cwd: context.workspace })).toBe(0)
        expect(yield* command("git", ["commit", "-qm", "changed"], { cwd: context.workspace })).toBe(0)
        const based = yield* review(["--base", "HEAD~1", "--json", "review.txt"], 60_000)
        expect(based.exitCode).toBe(0)
        expect(Schema.decodeUnknownSync(ReviewJson)(based.stdout).lanes).toHaveLength(3)

        yield* fileSystem.writeFileString(`${context.workspace}/review.txt`, "staged\n")
        expect(yield* command("git", ["add", "review.txt"], { cwd: context.workspace })).toBe(0)
        const json = yield* review(["--staged", "--json"], 60_000)
        expect(json.exitCode).toBe(0)
        expect(Schema.decodeUnknownSync(ReviewJson)(json.stdout)).toMatchObject({
          status: "satisfied",
          lanes: [
            { id: "correctness", status: "completed", output: laneOutput },
            { id: "security", status: "completed", output: laneOutput },
            { id: "quality", status: "completed", output: laneOutput },
          ],
        })

        const alternate = `${context.root}/alternate`
        yield* fileSystem.makeDirectory(alternate)
        for (const args of [
          ["init", "-q"],
          ["config", "user.email", "rika@example.test"],
          ["config", "user.name", "Rika Test"],
        ])
          expect(yield* command("git", args, { cwd: alternate })).toBe(0)
        yield* fileSystem.writeFileString(`${alternate}/alternate.txt`, "before\n")
        expect(yield* command("git", ["add", "alternate.txt"], { cwd: alternate })).toBe(0)
        expect(yield* command("git", ["commit", "-qm", "base"], { cwd: alternate })).toBe(0)
        yield* fileSystem.writeFileString(`${alternate}/alternate.txt`, "after\n")
        const workspace = yield* review(["--workspace", alternate, "alternate.txt"], 60_000)
        expect(workspace.exitCode).toBe(0)
        expect(workspace.stdout).toContain("## correctness")

        for (const failure of [
          yield* review(["--base", "missing-revision"]),
          yield* review(["--staged", "--base", "HEAD"]),
          yield* review(["--workspace", context.root]),
        ]) {
          expect(failure.exitCode).not.toBe(0)
          expect(failure.stderr.length).toBeGreaterThan(0)
        }
      }),
    ),
  240_000,
)
