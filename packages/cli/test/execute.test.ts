import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentLoop, ContextResolver, SkillRegistry, ToolExecutor } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Database, Migration, ProjectStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Codec, Common, Event, Ids, Message } from "@rika/schema"
import { Cause, Effect, Fiber, Layer, ManagedRuntime, Queue, Schema, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { BackendEndpoint, Execute, Input, Output } from "../src/index"

const defaultWorkspaceRoot = "/workspace/rika-cli-test"
const defaultDataDir = "/workspace/rika-cli-test/.rika"

const providerServiceOf = (
  implementation: Omit<Provider.Interface, "completeStructured"> &
    Partial<Pick<Provider.Interface, "completeStructured">>,
) =>
  Provider.Service.of({
    ...implementation,
    completeStructured:
      implementation.completeStructured ?? (() => Effect.die(new Error("structured completion not configured"))),
  })

const makeLayer = (
  output: Output.MemoryOutput,
  workspaceRoot = defaultWorkspaceRoot,
  dataDir = defaultDataDir,
  stdin = "",
  isTty = false,
  providerRegistryLayer = Provider.fakeRegistryLayer([
    { name: "anthropic", responses: ["cli response"] },
    { name: "openai", responses: ["cli response"] },
  ]),
  inputLayer: Layer.Layer<Input.Service> = Input.memoryLayer(stdin, isTty),
) =>
  Execute.layer.pipe(
    Layer.provideMerge(
      makeExecuteDependencies(output, workspaceRoot, dataDir, stdin, isTty, providerRegistryLayer, inputLayer),
    ),
  )

const makeExecuteDependencies = (
  output: Output.MemoryOutput,
  workspaceRoot = defaultWorkspaceRoot,
  dataDir = defaultDataDir,
  stdin = "",
  isTty = false,
  providerRegistryLayer = Provider.fakeRegistryLayer([
    { name: "anthropic", responses: ["cli response"] },
    { name: "openai", responses: ["cli response"] },
  ]),
  inputLayer: Layer.Layer<Input.Service> = Input.memoryLayer(stdin, isTty),
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(Common.TimestampMillis.make(1_950_000_000_000))
  const idLayer = IdGenerator.sequenceLayer(1)
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const toolLayer = ToolExecutor.emptyLayer.pipe(Layer.provideMerge(diagnosticsLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(providerRegistryLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const baseLayer = Layer.mergeAll(
    configLayer,
    Output.memoryLayer(output),
    databaseLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    idLayer,
    projectStoreLayer,
    diagnosticsLayer,
    inputLayer,
    ContextResolver.emptyLayer,
    SkillRegistry.emptyLayer,
    toolLayer,
    llmLayer,
  )

  return AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))
}

const makeRedactedShellExecuteLayer = (
  output: Output.MemoryOutput,
  workspaceRoot: string,
  dataDir: string,
  logPath: string,
  secret: string,
) => {
  const env = { FAKE_API_KEY: secret, RIKA_LOG_FILE: logPath }
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: "smart",
    },
    env,
  )
  const redactorLayer = SecretRedactor.layerFromEntries(SecretRedactor.entriesFromEnv(env))
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.fixedLayer(Common.TimestampMillis.make(1_950_000_000_000))
  const idLayer = IdGenerator.sequenceLayer(1)
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const providerRegistryLayer = Provider.fakeRegistryLayer([
    {
      name: "openai",
      responses: [
        { type: "tool-call", id: "call_cli_secret_shell", name: "shell_command", input: { command: "printf secret" } },
        "done",
      ],
    },
    {
      name: "anthropic",
      responses: [
        { type: "tool-call", id: "call_cli_secret_shell", name: "shell_command", input: { command: "printf secret" } },
        "done",
      ],
    },
  ])
  const diagnosticsLayer = Diagnostics.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(redactorLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(providerRegistryLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const toolLayer = ToolExecutor.fakeLayer({
    shell_command: () =>
      Effect.succeed({
        exit_code: 0,
        stdout: `${secret}\n`,
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        timed_out: false,
      }),
  }).pipe(Layer.provideMerge(diagnosticsLayer))
  const baseLayer = Layer.mergeAll(
    configLayer,
    Output.memoryLayer(output),
    databaseLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    idLayer,
    projectStoreLayer,
    diagnosticsLayer,
    Input.memoryLayer("", true),
    ContextResolver.emptyLayer,
    SkillRegistry.emptyLayer,
    toolLayer,
    llmLayer,
  )

  return Execute.layer.pipe(Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))))
}

describe("CLI execute", () => {
  test("runs one prompt and streams schema-parseable JSON events", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["run", "ship", "it", "--mode", "rush"])
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))
    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" })
  })

  test("prints actionable diagnostics and exits non-zero for invalid args", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Execute.execute(["run", "--bogus"]).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(2)
    expect(output.stdout).toEqual([])
    expect(output.stderr.join("\n")).toContain("Unrecognized flag: --bogus")
    expect(output.stderr.join("\n")).toContain("USAGE")
  })

  test("accepts explicit workspace and thread ids", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const threadId = Ids.ThreadId.make("thread_cli_explicit")

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["--execute", "--workspace", "/workspace/custom", "--thread", threadId, "hello"])
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    const first = Schema.decodeUnknownSync(Event.Event)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(first.thread_id).toBe(threadId)
    expect(first).toMatchObject({ type: "thread.created", data: { workspace_id: "/workspace/custom" } })
  })

  test("routes an existing orb thread through the resolved remote endpoint", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const threadId = Ids.ThreadId.make("thread_cli_remote")
    const workspaceId = Ids.WorkspaceId.make(defaultWorkspaceRoot)
    const turnId = Ids.TurnId.make("turn_cli_remote")
    const previous: Event.ThreadCreated = {
      id: Ids.EventId.make("event_cli_remote_created"),
      thread_id: threadId,
      sequence: 1,
      version: 1,
      created_at: Common.TimestampMillis.make(1_950_000_000_000),
      type: "thread.created",
      data: { workspace_id: workspaceId },
    }
    const terminal: Event.TurnCompleted = {
      id: Ids.EventId.make("event_cli_remote_completed"),
      thread_id: threadId,
      turn_id: turnId,
      sequence: 2,
      version: 1,
      created_at: Common.TimestampMillis.make(1_950_000_000_001),
      type: "turn.completed",
      data: { provider: "fake", model: "remote" },
    }
    const calls: Array<{ readonly path: string; readonly body?: unknown }> = []
    const client = Client.make({
      requestJson: (input) =>
        Effect.sync(() => {
          calls.push({ path: input.path, ...(input.body === undefined ? {} : { body: input.body }) })
          if (input.path === `/v1/threads/${threadId}`) {
            return { summary: threadSummary(threadId, workspaceId), events: [Codec.encode(Event.Event)(previous)] }
          }
          if (input.path === "/v1/turns") {
            return { thread_id: threadId, accepted: true }
          }
          throw new Error(`unexpected request ${input.path}`)
        }),
      streamJson: (input) =>
        Stream.fromEffectDrain(Effect.sync(() => calls.push({ path: input.path }))).pipe(
          Stream.concat(
            input.path === `/v1/threads/${threadId}/events?after_sequence=1`
              ? Stream.make(Codec.encode(Event.Event)(terminal))
              : Stream.fail(
                  new Client.SdkError({ message: `unexpected stream ${input.path}`, operation: "streamJson" }),
                ),
          ),
        ),
    })

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["--execute", "--thread", threadId, "remote please"])
      }).pipe(
        Effect.provide(
          Execute.layerWithClientFactory(() => client).pipe(
            Layer.provideMerge(makeExecuteDependencies(output)),
            Layer.provideMerge(
              Layer.succeed(
                BackendEndpoint.Resolver,
                BackendEndpoint.Resolver.of({
                  resolveEndpoint: () =>
                    Effect.succeed({
                      kind: "orb" as const,
                      url: "https://orb-endpoint.rika.test",
                      token: "orb-token",
                      orb_id: Ids.OrbId.make("orb_cli_remote"),
                      thread_id: threadId,
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
    )

    const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))

    expect(exitCode).toBe(0)
    expect(events).toEqual([terminal])
    expect(calls).toEqual([
      { path: `/v1/threads/${threadId}` },
      {
        path: "/v1/turns",
        body: {
          thread_id: threadId,
          workspace_id: workspaceId,
          content: "remote please",
        },
      },
      { path: `/v1/threads/${threadId}/events?after_sequence=1` },
    ])
    expect(output.stderr).toEqual([])
  })

  test("uses piped stdin as the execute prompt when no prompt argument is present", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["-x"])
      }).pipe(Effect.provide(makeLayer(output, defaultWorkspaceRoot, defaultDataDir, "say hi"))),
    )

    const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))
    const userMessage = events.find((event) => event.type === "message.added" && event.data.message.role === "user")

    expect(exitCode).toBe(0)
    expect(userMessage?.type === "message.added" ? Message.displayText(userMessage.data.message) : "").toBe("say hi")
    expect(output.stderr).toEqual([])
  })

  test("rejects execute without a prompt when stdin is a TTY", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["-x"])
      }).pipe(Effect.provide(makeLayer(output, defaultWorkspaceRoot, defaultDataDir, "", true))),
    )

    expect(exitCode).toBe(2)
    expect(output.stdout).toEqual([])
    expect(output.stderr.join("\n")).toContain("Prompt is required for --execute")
  })

  test("uses piped stdin as leading context before the prompt argument", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["-x", "answer", "this"])
      }).pipe(Effect.provide(makeLayer(output, defaultWorkspaceRoot, defaultDataDir, "file context"))),
    )

    const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))
    const userMessage = events.find((event) => event.type === "message.added" && event.data.message.role === "user")

    expect(exitCode).toBe(0)
    expect(userMessage?.type === "message.added" ? Message.displayText(userMessage.data.message) : "").toBe(
      "file context\n\nanswer this",
    )
    expect(output.stderr).toEqual([])
  })

  test("runs stream JSON input messages as sequential turns on one thread", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const input = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "first" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "second" }] },
      }),
    ].join("\n")

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["-x", "--stream-json", "--stream-json-input", "--thread", "thread_cli_input"])
      }).pipe(Effect.provide(makeLayer(output, defaultWorkspaceRoot, defaultDataDir, `${input}\n`))),
    )

    const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))
    const userMessages = events.flatMap((event) =>
      event.type === "message.added" && event.data.message.role === "user"
        ? [Message.displayText(event.data.message)]
        : [],
    )

    expect(exitCode).toBe(0)
    expect(events.filter((event) => event.type === "thread.created")).toHaveLength(1)
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2)
    expect(userMessages).toEqual(["first", "second"])
    expect(new Set(events.map((event) => event.thread_id))).toEqual(new Set([Ids.ThreadId.make("thread_cli_input")]))
    expect(output.stderr).toEqual([])
  })

  test("starts stream JSON input turns before stdin closes", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const lineQueue = await Effect.runPromise(Queue.unbounded<string, Cause.Done>())
    const inputLayer = Layer.succeed(
      Input.Service,
      Input.Service.of({
        readAll: Effect.never,
        isTty: Effect.succeed(false),
        lines: Stream.fromQueue(lineQueue),
      }),
    )
    const runtime = ManagedRuntime.make(
      makeLayer(output, defaultWorkspaceRoot, defaultDataDir, "", false, undefined, inputLayer),
    )
    const fiber = runtime.runFork(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["-x", "--stream-json", "--stream-json-input"])
      }),
    )

    try {
      await Effect.runPromise(
        Queue.offer(
          lineQueue,
          JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: "first before eof" }] },
          }),
        ),
      )
      const eventsBeforeEof = await Effect.runPromise(
        waitForOutputEvent(output, "turn.completed").pipe(Effect.timeout("1 second")),
      )
      await Effect.runPromise(Queue.end(lineQueue))
      const exitCode = await runtime.runPromise(Fiber.join(fiber))

      expect(exitCode).toBe(0)
      expect(eventsBeforeEof.some((event) => event.type === "turn.completed")).toBe(true)
      expect(output.stderr).toEqual([])
    } finally {
      await runtime.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore))
      await runtime.dispose()
    }
  })

  test("returns non-zero when the streamed turn ends with turn.failed", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const failure = AiError.make({
      module: "LanguageModel",
      method: "streamText",
      reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
    })
    const providerNames: ReadonlyArray<Provider.ProviderName> = ["anthropic", "openai"]
    const providerRegistryLayer = Provider.registryLayerFromProviders(
      providerNames.map((name) =>
        providerServiceOf({
          name,
          complete: () => Effect.fail(failure),
          stream: () => Stream.fail(failure),
        }),
      ),
    )

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["-x", "fail", "--mode", "rush", "--stream-json"])
      }).pipe(
        Effect.provide(makeLayer(output, defaultWorkspaceRoot, defaultDataDir, "", false, providerRegistryLayer)),
      ),
    )

    const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))

    expect(exitCode).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: "turn.failed" })
    expect(output.stderr).toEqual([])
  })

  test("redacts shell env secrets in streamed events, SQLite payloads, and diagnostics file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rika-cli-secret-redaction-"))
    const workspaceRoot = join(directory, "workspace")
    const dataDir = join(directory, ".rika")
    const logPath = join(directory, "session.ndjson")
    const secret = "shell-secret-from-env"
    const redacted = "[REDACTED:FAKE_API_KEY]"
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const exitCode = yield* Execute.execute(["-x", "--thread", "thread_cli_secret_redaction", "run shell"])
          yield* Diagnostics.emit({
            level: "info",
            message: "shell stdout",
            data: { stdout: `${secret}\n` },
          })
          const payloads = yield* Database.withDatabase((database) =>
            database.all<{ payload: string }>("select payload from thread_events order by sequence asc"),
          )
          return { exitCode, payloads }
        }).pipe(Effect.provide(makeRedactedShellExecuteLayer(output, workspaceRoot, dataDir, logPath, secret))),
      )
      const streamed = output.stdout.join("\n")
      const payloads = JSON.stringify(result.payloads)
      const diagnostics = await readFile(logPath, "utf8")

      expect(result.exitCode).toBe(0)
      expect(streamed).toContain(redacted)
      expect(payloads).toContain(redacted)
      expect(diagnostics).toContain(redacted)
      expect(streamed).not.toContain(secret)
      expect(payloads).not.toContain(secret)
      expect(diagnostics).not.toContain(secret)
      expect(output.stderr).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("uses project workspace identity when the git remote matches a stored project", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-cli-execute-data-"))
    const workspaceRoot = await mkdtemp(join(tmpdir(), "rika-cli-execute-workspace-"))
    await runGit(workspaceRoot, ["init"])
    await runGit(workspaceRoot, ["remote", "add", "origin", "https://github.com/x/y"])
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({ name: "demo", repo_origin: "https://github.com/x/y" })
        return yield* Execute.execute(["run", "--workspace", workspaceRoot, "hello"])
      }).pipe(Effect.provide(makeLayer(output, workspaceRoot, dataDir))),
    )

    const first = Schema.decodeUnknownSync(Event.Event)(JSON.parse(output.stdout[0] ?? "{}"))

    expect(exitCode).toBe(0)
    expect(first).toMatchObject({
      type: "thread.created",
      data: { workspace_id: Ids.WorkspaceId.make("project:project_1") },
    })
    expect(output.stderr).toEqual([])
    await rm(dataDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  })
})

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()])
  if (exitCode !== 0) throw new Error(stderr)
}

const threadSummary = (threadId: Ids.ThreadId, workspaceId: Ids.WorkspaceId) => ({
  thread_id: threadId,
  workspace_id: workspaceId,
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  created_at: Common.TimestampMillis.make(1_950_000_000_000),
  updated_at: Common.TimestampMillis.make(1_950_000_000_000),
})

const waitForOutputEvent = (output: Output.MemoryOutput, type: Event.Event["type"]) =>
  Effect.gen(function* () {
    while (true) {
      const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))
      if (events.some((event) => event.type === type)) return events
      yield* Effect.sleep("10 millis")
    }
  })
