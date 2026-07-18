import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { run, runCommand, runTest, sandbox, type Sandbox } from "./process"

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
    "MCP OAuth status, protected storage, malformed storage, and logout run from the artifact",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const tokenFile = path.join(context.root, "home", ".config", "rika", "mcp-oauth.json")
          const serverUrl = "https://example.test/mcp"
          expect((yield* run(context, ["mcp", "add", "oauth-fixture", "--url", serverUrl])).exitCode).toBe(0)
          const status = yield* run(context, ["mcp", "oauth", "status", "oauth-fixture"])
          expect(status.exitCode).toBe(0)
          expect(status.stdout).toContain("unauthenticated")
          expect(status.stdout).not.toContain("access_token")
          yield* fileSystem.makeDirectory(path.dirname(tokenFile), { recursive: true })
          yield* fileSystem.writeFileString(tokenFile, JSON.stringify({ [serverUrl]: "journey-token-secret" }), {
            mode: 0o644,
          })
          const authenticated = yield* run(context, ["mcp", "oauth", "status", "oauth-fixture"])
          expect(authenticated.exitCode).toBe(0)
          expect(authenticated.stdout).toContain("authenticated")
          expect(authenticated.stdout).not.toContain("journey-token-secret")
          expect((yield* fileSystem.stat(tokenFile)).mode & 0o777).toBe(0o600)
          expect((yield* run(context, ["mcp", "oauth", "logout", "oauth-fixture"])).exitCode).toBe(0)
          expect(yield* fileSystem.readFileString(tokenFile)).not.toContain("journey-token-secret")
          yield* fileSystem.writeFileString(tokenFile, '{"access_token":"malformed-secret"', { mode: 0o644 })
          const malformed = yield* run(context, ["mcp", "oauth", "status", "oauth-fixture"])
          expect(malformed.exitCode).not.toBe(0)
          expect(`${malformed.stdout}\n${malformed.stderr}`).not.toContain("malformed-secret")
          expect((yield* fileSystem.stat(tokenFile)).mode & 0o777).toBe(0o600)
        }),
      ),
    20_000,
  )

  test(
    "extension lifecycle state, rollback floor, failures, and concurrent commands survive process reopen",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const storage = path.join(context.workspace, ".rika", "extensions.json")
          expect((yield* run(context, ["extensions", "enable", "enabled"])).exitCode).toBe(0)
          expect((yield* run(context, ["extensions", "disable", "disabled"])).exitCode).toBe(0)
          yield* fileSystem.writeFileString(
            storage,
            '{"extensions":{"enabled":{"enabled":true,"generation":3},"disabled":{"enabled":false,"generation":1}}}',
          )
          expect((yield* run(context, ["extensions", "rollback", "enabled"])).exitCode).toBe(0)
          expect((yield* run(context, ["extensions", "rollback", "disabled"])).exitCode).toBe(0)
          const listed = yield* run(context, ["extensions", "list"])
          expect(listed.exitCode).toBe(0)
          expect(decodeJson(listed.stdout)).toEqual({
            disabled: { enabled: false, generation: 1 },
            enabled: { enabled: true, generation: 2 },
          })
          for (const action of ["create-skill", "create-plugin"] as const) {
            const rejected = yield* run(context, ["extensions", action, "forbidden"])
            expect(rejected.exitCode).not.toBe(0)
            expect(rejected.stderr).toContain("outside extension lifecycle behavior")
          }
          const malformed = '{"extensions":{"broken":{"enabled":true,"generation":0}}}'
          yield* fileSystem.writeFileString(storage, malformed)
          const failed = yield* run(context, ["extensions", "enable", "safe"])
          expect(failed.exitCode).not.toBe(0)
          expect(failed.stderr).toContain("positive integers")
          expect(yield* fileSystem.readFileString(storage)).toBe(malformed)
          yield* fileSystem.writeFileString(storage, '{"extensions":{}}')
          const names = Array.from({ length: 4 }, (_, index) => `concurrent-${index}`)
          const [results, observed] = yield* Effect.all(
            [
              Effect.forEach(
                names,
                (name, index) =>
                  runCommand(context, context.binary, ["extensions", "enable", name], {
                    env: {
                      RIKA_DATABASE: path.join(context.root, "writers", String(index), "rika.db"),
                      RIKA_RELAY_DATABASE: path.join(context.root, "writers", String(index), "relay.db"),
                      RIKA_INTERNAL_RESIDENT_STARTUP_HOLD: "1000",
                    },
                  }),
                { concurrency: "unbounded" },
              ),
              Effect.forEach(
                Array.from({ length: 20 }),
                (_, index) =>
                  Effect.sleep(`${index * 50} millis`).pipe(
                    Effect.andThen(fileSystem.readFileString(storage)),
                    Effect.map(decodeJson),
                  ),
                { concurrency: "unbounded" },
              ),
            ],
            { concurrency: 2 },
          )
          expect(results.every(({ exitCode }) => exitCode === 0)).toBe(true)
          expect(observed.every((value) => value !== undefined)).toBe(true)
          const concurrent = decodeJson((yield* run(context, ["extensions", "list"])).stdout) as Record<
            string,
            { enabled: boolean; generation: number }
          >
          expect(Object.keys(concurrent).toSorted()).toEqual(names.toSorted())
          expect(Object.values(concurrent).every(({ enabled, generation }) => enabled && generation === 1)).toBe(true)
        }),
      ),
    30_000,
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
