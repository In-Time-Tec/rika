import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { run, runSignaled, runTest, sandbox, type Sandbox } from "./process"

const NamedItemsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
const NamedItemJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String }))
const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const ExportJson = Schema.fromJsonString(Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }))
const EventJson = Schema.fromJsonString(Schema.Struct({ type: Schema.String }))
const WorkflowJson = Schema.fromJsonString(
  Schema.Struct({
    runId: Schema.String,
    workflow: Schema.String,
    revision: Schema.Int,
    digest: Schema.String,
    status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  }),
)

const fileTree = Effect.fn("CliContract.fileTree")(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries: Array<string> = []
  const visit = Effect.fn("CliContract.fileTree.visit")(function* (directory: string) {
    for (const name of (yield* fileSystem.readDirectory(directory)).toSorted()) {
      const absolute = path.join(directory, name)
      const relative = path.relative(root, absolute)
      const info = yield* fileSystem.stat(absolute)
      entries.push(`${info.type}:${relative}`)
      if (info.type === "Directory") yield* visit(absolute)
    }
  })
  yield* visit(root)
  return entries
})

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
    "help, version, and parser failures leave every local surface untouched",
    () =>
      runTest(
        Effect.gen(function* () {
          const parsing = yield* sandbox
          const baseline = yield* fileTree(parsing.root)
          const successful = [
            ["--help"],
            ["--version"],
            ["version"],
            ["run", "--help"],
            ["threads", "--help"],
            ["threads", "continue", "--help"],
            ["config", "--help"],
            ["diagnostics", "--help"],
            ["tools", "--help"],
            ["skills", "--help"],
            ["mcp", "--help"],
            ["mcp", "oauth", "--help"],
            ["extensions", "--help"],
            ["workflows", "--help"],
            ["review", "--help"],
          ]
          for (const args of successful) {
            const result = yield* run(parsing, args)
            expect(result.exitCode, args.join(" ")).toBe(0)
            expect(result.stdout.length + result.stderr.length, args.join(" ")).toBeGreaterThan(0)
            expect(yield* fileTree(parsing.root), args.join(" ")).toEqual(baseline)
          }
          const rejected = [
            ["--unknown-option"],
            ["--mode", "impossible"],
            ["--workspace", `${parsing.root}/missing`],
            ["run", "--mode", "impossible"],
            ["run", "--stream-json-input"],
            ["--stream-json"],
            ["threads", "continue"],
            ["threads", "continue", "thread-1", "--last"],
            ["threads", "list", "--limit", "zero"],
            ["threads", "export", "thread-1", "--format", "xml"],
            ["mcp", "add", "server"],
            ["mcp", "add", "server", "bun", "--url", "https://example.test"],
            ["diagnostics", "export"],
            ["workflows", "start", "missing", "run-1"],
          ]
          for (const args of rejected) {
            const result = yield* run(parsing, args)
            expect(result.exitCode, args.join(" ")).not.toBe(0)
            expect(result.stderr.length + result.stdout.length, args.join(" ")).toBeGreaterThan(0)
            expect(yield* fileTree(parsing.root), args.join(" ")).toEqual(baseline)
          }
          yield* parsing.dispose
        }),
      ),
    30_000,
  )

  test(
    "diagnostic commands remain local when product configuration is unusable",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const diagnosticContext = yield* sandbox
          const diagnostic = path.join(path.dirname(diagnosticContext.env.RIKA_DATABASE!), "diagnostics")
          const source = path.join(diagnostic, "client-finished.jsonl")
          const settings = path.join(diagnosticContext.env.HOME!, ".rika", "settings.json")
          const destination = path.join(diagnosticContext.root, "exported-diagnostics")
          yield* fileSystem.makeDirectory(diagnostic, { recursive: true })
          yield* fileSystem.makeDirectory(path.dirname(settings), { recursive: true })
          yield* fileSystem.writeFileString(source, '{"message":"finished"}\n')
          yield* fileSystem.chmod(source, 0o600)
          yield* fileSystem.writeFileString(settings, "not-json")

          const pathResult = yield* run(diagnosticContext, ["diagnostics", "path"])
          expect(pathResult.exitCode).toBe(0)
          expect(pathResult.stdout).toBe(diagnostic)
          const status = yield* run(diagnosticContext, ["diagnostics", "status"])
          expect(status.exitCode).toBe(0)
          expect(status.stdout).toContain("1 log file")
          const exported = yield* run(diagnosticContext, ["diagnostics", "export", destination])
          expect(exported.exitCode).toBe(0)
          expect(yield* fileSystem.readFileString(path.join(destination, "client-finished.jsonl"))).toBe(
            '{"message":"finished"}\n',
          )
          expect(yield* fileSystem.exists(diagnosticContext.env.RIKA_DATABASE!)).toBe(false)
          expect(yield* fileSystem.exists(diagnosticContext.env.RIKA_RELAY_DATABASE!)).toBe(false)
          expect((yield* fileSystem.readDirectory(diagnostic)).toSorted()).toEqual(["client-finished.jsonl"])
          yield* diagnosticContext.dispose
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
    "rejects an unknown initial interactive thread",
    () =>
      runTest(
        Effect.gen(function* () {
          const invalid = yield* run(context, ["--thread", "missing-interactive-thread"])
          expect(invalid.exitCode).not.toBe(0)
          expect(`${invalid.stderr}${invalid.stdout}`).toContain("Thread missing-interactive-thread does not exist")
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
    "configuration precedence, malformed files, and editor targets work through packaged processes",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const isolated = yield* sandbox
          const globalDirectory = `${isolated.root}/home/.config/rika`
          const workspaceDirectory = `${isolated.workspace}/.rika`
          const editorDirectory = `${isolated.root}/editor with spaces`
          const editorPath = `${editorDirectory}/capture editor`
          const capturePath = `${isolated.root}/edited-paths.txt`
          yield* fileSystem.makeDirectory(globalDirectory, { recursive: true })
          yield* fileSystem.makeDirectory(workspaceDirectory, { recursive: true })
          yield* fileSystem.makeDirectory(editorDirectory)
          yield* fileSystem.writeFileString(editorPath, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${capturePath}"\n`)
          yield* fileSystem.chmod(editorPath, 0o755)
          isolated.env.EDITOR = editorPath
          yield* fileSystem.writeFileString(
            `${globalDirectory}/settings.json`,
            JSON.stringify({
              keymap: { submit: "ctrl+enter", newline: "alt+enter" },
              notifications: { enabled: false },
            }),
          )
          yield* fileSystem.writeFileString(
            `${workspaceDirectory}/settings.json`,
            JSON.stringify({ keymap: { submit: "alt+s" } }),
          )
          const listed = yield* run(isolated, ["config", "list"])
          expect(listed.exitCode, `${listed.stdout}\n${listed.stderr}`).toBe(0)
          expect(listed.stdout).toContain('"submit": "alt+s"')
          expect(listed.stdout).toContain('"newline": "alt+enter"')
          expect(listed.stdout).toContain('"enabled": false')

          yield* fileSystem.writeFileString(
            `${workspaceDirectory}/settings.json`,
            '{"notifications":{"enabled":"yes"}}',
          )
          const malformed = yield* run(isolated, ["config", "list"])
          expect(malformed.exitCode).not.toBe(0)
          expect(`${malformed.stdout}${malformed.stderr}`).toContain("Notifications enabled must be a boolean")

          yield* fileSystem.writeFileString(`${workspaceDirectory}/settings.json`, "{}")
          expect((yield* run(isolated, ["config", "edit"])).exitCode).toBe(0)
          expect((yield* run(isolated, ["config", "edit", "--workspace"])).exitCode).toBe(0)
          expect((yield* fileSystem.readFileString(capturePath)).trim().split("\n")).toEqual([
            `${globalDirectory}/settings.json`,
            `${workspaceDirectory}/settings.json`,
          ])
          yield* isolated.dispose
        }),
      ),
    30_000,
  )

  test(
    "continue, fork, export, and usage work across real processes",
    () =>
      runTest(
        Effect.gen(function* () {
          const created = Schema.decodeUnknownSync(ThreadJson)((yield* run(context, ["threads", "create"])).stdout)
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

  test(
    "workflow runs pin revisions and remain inspectable after cancellation",
    () =>
      runTest(
        Effect.scoped(
          Effect.gen(function* () {
            const workflow = yield* sandbox
            yield* Effect.addFinalizer(() => workflow.dispose)
            workflow.env.RIKA_INTERNAL_RESIDENT_GRACE = "1000"
            workflow.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
              { parts: [{ type: "text", text: "delayed research" }], delayMs: 10_000 },
              { parts: [{ type: "text", text: "delayed research" }], delayMs: 10_000 },
            ])
            delete workflow.env.RIKA_TEST_MODEL_RESPONSE
            const missingRevision = yield* run(
              workflow,
              ["workflows", "start", "delivery", "missing-revision", "--revision", "999"],
              { timeout: 20_000 },
            )
            expect(missingRevision.exitCode).not.toBe(0)
            const started = yield* run(workflow, ["workflows", "start", "research-synthesis", "research-run"], {
              timeout: 20_000,
            })
            expect(started.exitCode).toBe(0)
            const pin = Schema.decodeUnknownSync(WorkflowJson)(started.stdout)
            expect(pin).toMatchObject({
              runId: "research-run",
              workflow: "research-synthesis",
              revision: 1,
              status: "running",
            })
            expect(pin.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
            const cancelled = yield* run(workflow, ["workflows", "cancel", "research-run"], { timeout: 20_000 })
            expect(cancelled.exitCode).toBe(0)
            expect(Schema.decodeUnknownSync(WorkflowJson)(cancelled.stdout)).toMatchObject({
              runId: pin.runId,
              revision: pin.revision,
              digest: pin.digest,
              status: "cancelled",
            })
            const inspected = yield* run(workflow, ["workflows", "inspect", "research-run"], { timeout: 20_000 })
            expect(inspected.exitCode).toBe(0)
            expect(Schema.decodeUnknownSync(WorkflowJson)(inspected.stdout)).toMatchObject({
              runId: pin.runId,
              revision: pin.revision,
              digest: pin.digest,
              status: "cancelled",
            })
          }),
        ),
      ),
    60_000,
  )

  test("SIGINT tears down an interactive terminal process", () =>
    runTest(
      Effect.gen(function* () {
        yield* runSignaled(context, [], "SIGINT")
      }),
    ))
})
