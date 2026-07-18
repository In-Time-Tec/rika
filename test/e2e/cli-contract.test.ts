import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Effect, FileSystem, Schema } from "effect"
import { run, runSignaled, runTest, sandbox, type Sandbox } from "./process"

const NamedItemsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
const NamedItemJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String }))
const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const ExportJson = Schema.fromJsonString(Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }))
const EventJson = Schema.fromJsonString(Schema.Struct({ type: Schema.String }))

let context: Sandbox

beforeAll(() =>
  runTest(
    sandbox.pipe(
      Effect.tap((created) =>
        Effect.sync(() => {
          context = created
        }),
      ),
    ),
  ),
)
afterAll(() => runTest(context.dispose))

describe("packaged CLI contract", () => {
  test(
    "help, version, and parser failures have stable exit behavior",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const parsing = yield* sandbox
          const help = yield* run(parsing, ["--help"])
          expect(help.exitCode).toBe(0)
          expect(help.stdout).toContain("Local durable coding agent")
          expect((yield* run(parsing, ["--version"])).stdout).toContain("0.0.0")
          const invalid = yield* run(parsing, ["run", "--mode", "impossible"])
          expect(invalid.exitCode).not.toBe(0)
          expect(invalid.stderr.length + invalid.stdout.length).toBeGreaterThan(0)
          expect(yield* fileSystem.exists(parsing.env.RIKA_DATABASE!)).toBe(false)
          expect(yield* fileSystem.exists(parsing.env.RIKA_RELAY_DATABASE!)).toBe(false)
          yield* parsing.dispose
        }),
      ),
    20_000,
  )

  test(
    "tools list and show expose the packaged catalog",
    () =>
      runTest(
        Effect.gen(function* () {
          const listed = yield* run(context, ["tools", "list"])
          expect(listed.exitCode).toBe(0)
          const tools = Schema.decodeUnknownSync(NamedItemsJson)(listed.stdout)
          expect(tools.some((tool) => tool.name === "read_file")).toBe(true)
          const shown = yield* run(context, ["tools", "show", "read_file"])
          expect(shown.exitCode).toBe(0)
          expect(Schema.decodeUnknownSync(NamedItemJson)(shown.stdout).name).toBe("read_file")
          expect((yield* run(context, ["tools", "show", "missing-tool"])).exitCode).not.toBe(0)
        }),
      ),
    20_000,
  )

  test(
    "config, keymap, and doctor never disclose configured secrets",
    () =>
      runTest(
        Effect.gen(function* () {
          context.env.PARALLEL_API_KEY = "e2e-super-secret"
          for (const args of [["config", "list"], ["config", "keymap"], ["doctor"]]) {
            const result = yield* run(context, args)
            expect(result.exitCode).toBe(0)
            expect(`${result.stdout}${result.stderr}`).not.toContain("e2e-super-secret")
          }
        }),
      ),
    20_000,
  )

  test(
    "continue, fork, export, and usage work across real processes",
    () =>
      runTest(
        Effect.gen(function* () {
          const created = Schema.decodeUnknownSync(ThreadJson)((yield* run(context, ["threads", "new"])).stdout)
          const continued = yield* run(context, ["threads", "continue", created.id])
          expect(continued.exitCode).toBe(0)
          const forked = Schema.decodeUnknownSync(ThreadJson)(
            (yield* run(context, ["threads", "fork", created.id])).stdout,
          )
          expect(forked.id).not.toBe(created.id)
          const exported = yield* run(context, ["threads", "export", created.id, "--format", "json"])
          expect(exported.exitCode).toBe(0)
          expect(Schema.decodeUnknownSync(ExportJson)(exported.stdout).thread.id).toBe(created.id)
          const usage = yield* run(context, ["threads", "usage", created.id])
          expect(usage.exitCode).toBe(0)
          expect(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(usage.stdout)).toBeDefined()
        }),
      ),
    20_000,
  )

  test(
    "execute streams JSONL and rejects malformed JSON input",
    () =>
      runTest(
        Effect.gen(function* () {
          const streamed = yield* run(context, ["--execute", "--stream-json", "hello"])
          expect(streamed.exitCode).toBe(0)
          const events = streamed.stdout.split("\n").map((line) => Schema.decodeUnknownSync(EventJson)(line))
          expect(events.some((event) => event.type === "execution.completed")).toBe(true)
          const malformed = yield* run(context, ["--execute", "--stream-json", "--stream-json-input"], {
            input: "not-json\n",
          })
          expect(malformed.exitCode).not.toBe(0)
        }),
      ),
    20_000,
  )

  test("SIGINT tears down an interactive terminal process", () =>
    runTest(
      Effect.gen(function* () {
        yield* runSignaled(context, [], "SIGINT")
      }),
    ))
})
