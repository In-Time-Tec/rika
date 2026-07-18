import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { run, runTest, sandbox, type Sandbox } from "./process"

const decodeJson = Schema.decodeSync(Schema.UnknownFromJsonString)
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

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

describe("packaged extension and operation contract", () => {
  test(
    "skills can be added, inspected, listed, and removed",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const source = path.join(context.root, "example-skill")
          yield* fileSystem.makeDirectory(source)
          yield* fileSystem.writeFileString(
            path.join(source, "SKILL.md"),
            "---\nname: example-skill\ndescription: E2E skill\n---\n\n# Example\n",
          )
          expect((yield* run(context, ["skills", "add", source])).exitCode).toBe(0)
          const listed = yield* run(context, ["skills", "list"])
          expect(listed.exitCode).toBe(0)
          expect(listed.stdout).toContain("example-skill")
          expect((yield* run(context, ["skills", "inspect", "example-skill"])).stdout).toContain("# Example")
          expect((yield* run(context, ["skills", "remove", "example-skill"])).exitCode).toBe(0)
        }),
      ),
    20_000,
  )

  test(
    "MCP configuration lifecycle and doctor run from the artifact",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const configPath = path.join(context.workspace, ".rika", "mcp.json")
          expect((yield* run(context, ["mcp", "add", "fixture", "echo", "ready"])).exitCode).toBe(0)
          const duplicate = yield* run(context, ["mcp", "add", "fixture", "--url", "https://example.test/mcp"])
          expect(duplicate.exitCode).not.toBe(0)
          expect(duplicate.stderr).toContain("Duplicate server")
          expect((yield* run(context, ["mcp", "list"])).stdout).toContain("fixture")
          expect((yield* run(context, ["mcp", "disable", "fixture"])).exitCode).toBe(0)
          expect((yield* run(context, ["mcp", "enable", "fixture"])).exitCode).toBe(0)
          expect((yield* run(context, ["mcp", "approve", "fixture", "--workspace", context.workspace])).exitCode).toBe(
            0,
          )
          expect((yield* run(context, ["mcp", "doctor"])).exitCode).toBe(0)
          expect((yield* run(context, ["mcp", "remove", "fixture"])).exitCode).toBe(0)

          const names = Array.from({ length: 8 }, (_, index) => `concurrent-${index}`)
          const additions = yield* Effect.forEach(names, (name) => run(context, ["mcp", "add", name, "echo", name]), {
            concurrency: "unbounded",
          })
          expect(additions.every((result) => result.exitCode === 0)).toBe(true)
          const concurrent = decodeJson(yield* fileSystem.readFileString(configPath)) as {
            readonly servers: Readonly<Record<string, unknown>>
          }
          expect(Object.keys(concurrent.servers).toSorted()).toEqual(names.toSorted())
          yield* Effect.forEach(names, (name) => run(context, ["mcp", "remove", name]), {
            concurrency: "unbounded",
            discard: true,
          })

          const secret = "must-not-appear"
          yield* fileSystem.writeFileString(
            configPath,
            encodeJson({
              servers: { remote: { url: "https://example.test/mcp", headers: { Authorization: secret } } },
            }),
          )
          const doctor = yield* run(context, ["mcp", "doctor"])
          expect(doctor.exitCode).toBe(0)
          expect(doctor.stdout).toContain("remote")
          expect(`${doctor.stdout}${doctor.stderr}`).not.toContain(secret)
          yield* fileSystem.writeFileString(
            configPath,
            '{"servers":{"mixed":{"command":"echo","url":"https://example.test"}}}',
          )
          const malformed = yield* run(context, ["mcp", "doctor"])
          expect(malformed.exitCode).not.toBe(0)
          expect(malformed.stderr).toContain("exactly one")
          yield* fileSystem.remove(configPath)
        }),
      ),
    20_000,
  )

  test(
    "MCP OAuth status and logout run from the artifact without exposing credentials",
    () =>
      runTest(
        Effect.gen(function* () {
          expect(
            (yield* run(context, ["mcp", "add", "oauth-fixture", "--url", "https://example.test/mcp"])).exitCode,
          ).toBe(0)
          const status = yield* run(context, ["mcp", "oauth", "status", "oauth-fixture"])
          expect(status.exitCode).toBe(0)
          expect(status.stdout).toContain("unauthenticated")
          expect(status.stdout).not.toContain("access_token")
          expect((yield* run(context, ["mcp", "oauth", "logout", "oauth-fixture"])).exitCode).toBe(0)
        }),
      ),
    20_000,
  )

  test(
    "plugin and extension generations persist across process reopen",
    () =>
      runTest(
        Effect.gen(function* () {
          for (const action of ["enable", "disable", "rollback"] as const)
            expect((yield* run(context, ["extensions", action, "fixture"])).exitCode).toBe(0)
          expect((yield* run(context, ["extensions", "list"])).stdout).toContain("fixture")
        }),
      ),
    20_000,
  )

  test(
    "review, config, doctor, and typed failures have stable process behavior",
    () =>
      runTest(
        Effect.gen(function* () {
          expect((yield* run(context, ["review", "--help"])).exitCode).toBe(0)
          expect((yield* run(context, ["config", "list"])).exitCode).toBe(0)
          expect((yield* run(context, ["doctor"])).exitCode).toBe(0)
          for (const args of [
            ["threads", "show", "missing-thread"],
            ["skills", "inspect", "missing-skill"],
            ["mcp", "add", "invalid"],
            ["tools", "show", "missing-tool"],
          ]) {
            const result = yield* run(context, args)
            expect(result.exitCode).not.toBe(0)
            expect(result.stderr).not.toBe("")
          }
        }),
      ),
    20_000,
  )
})
