import { describe, expect, test } from "bun:test"
import { Config } from "@rika/core"
import { Ids } from "@rika/schema"
import { Effect, Fiber, Layer, Stream } from "effect"
import { SandboxClient, SandboxClientFake } from "../src/index"

const config = {
  workspace_root: "/workspace",
  data_dir: "/workspace/.rika",
  default_mode: "deep3" as const,
}

const metadata: SandboxClient.SandboxMetadata = {
  thread_id: Ids.ThreadId.make("thread_orb_test"),
  project_id: Ids.ProjectId.make("project_orb_test"),
  purpose: "unit",
}

describe("SandboxClient", () => {
  test("fake layer creates, lists, checks templates, pauses, resumes, times out, and kills sandboxes through the service contract", async () => {
    const state = SandboxClientFake.makeState({ templates: ["rika-orb"] })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const templateFound = yield* SandboxClient.templateExists("rika-orb")
        const templateMissing = yield* SandboxClient.templateExists("missing-template")
        const created = yield* SandboxClient.create({
          templateId: "rika-orb",
          envs: { RIKA_MODE: "deep3" },
          metadata,
          timeoutMs: 60_000,
        })
        yield* SandboxClient.pause(created.sandboxId)
        yield* SandboxClient.resume(created.sandboxId)
        yield* SandboxClient.setTimeout(created.sandboxId, 30_000)
        const listed = yield* SandboxClient.list({ metadata: { thread_id: metadata.thread_id } })
        yield* SandboxClient.kill(created.sandboxId)
        return { created, listed, templateFound, templateMissing }
      }).pipe(Effect.provide(SandboxClientFake.layer(state))),
    )

    expect(result.templateFound).toBe(true)
    expect(result.templateMissing).toBe(false)
    expect(result.created).toEqual({ sandboxId: "sandbox_1" })
    expect(result.listed).toEqual([
      {
        sandboxId: "sandbox_1",
        templateId: "rika-orb",
        metadata,
        state: "running",
      },
    ])
    expect(state.calls.create).toEqual([
      {
        templateId: "rika-orb",
        envs: { RIKA_MODE: "deep3" },
        metadata,
        timeoutMs: 60_000,
      },
    ])
    expect(state.calls.pause).toEqual(["sandbox_1"])
    expect(state.calls.resume).toEqual(["sandbox_1"])
    expect(state.calls.setTimeout).toEqual([{ sandboxId: "sandbox_1", timeoutMs: 30_000 }])
    expect(state.calls.kill).toEqual(["sandbox_1"])
    expect(state.calls.templateExists).toEqual(["rika-orb", "missing-template"])
  })

  test("fake layer streams scripted stdout, stderr, and exit chunks while recording exec calls", async () => {
    const state = SandboxClientFake.makeState({
      execResults: [
        [
          { type: "stdout", data: "hi\n" },
          { type: "stderr", data: "warn\n" },
          { type: "exit", exitCode: 7 },
        ],
      ],
    })

    const chunks = await Effect.runPromise(
      SandboxClient.exec("sandbox_1", ["bash", "-lc", "echo hi"], {
        cwd: "/workspace",
        envs: { A: "B" },
      }).pipe(Stream.runCollect, Effect.provide(SandboxClientFake.layer(state))),
    )

    expect(Array.from(chunks)).toEqual([
      { type: "stdout", data: "hi\n" },
      { type: "stderr", data: "warn\n" },
      { type: "exit", exitCode: 7 },
    ])
    expect(state.calls.exec).toEqual([
      {
        sandboxId: "sandbox_1",
        cmd: ["bash", "-lc", "echo hi"],
        opts: { cwd: "/workspace", envs: { A: "B" } },
      },
    ])
  })

  test("fake layer can represent a detached background command start", async () => {
    const state = SandboxClientFake.makeState({
      execResults: [[{ type: "started", pid: 123 }]],
    })

    const chunks = await Effect.runPromise(
      SandboxClient.exec("sandbox_1", ["python", "-m", "http.server", "3000"], {
        background: true,
      }).pipe(Stream.runCollect, Effect.provide(SandboxClientFake.layer(state))),
    )

    expect(Array.from(chunks)).toEqual([{ type: "started", pid: 123 }])
    expect(state.calls.exec).toEqual([
      {
        sandboxId: "sandbox_1",
        cmd: ["python", "-m", "http.server", "3000"],
        opts: { background: true },
      },
    ])
  })

  test("fake layer records exec kill when an exec stream is interrupted", async () => {
    const state = SandboxClientFake.makeState({
      execResults: [{ interruptible: true }],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* SandboxClient.exec("sandbox_1", ["sleep", "60"], {}).pipe(
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(SandboxClientFake.layer(state))),
    )

    expect(state.calls.execKill).toEqual([
      {
        sandboxId: "sandbox_1",
        cmd: ["sleep", "60"],
        opts: {},
      },
    ])
  })

  test("fake layer round-trips files and returns deterministic host URLs", async () => {
    const state = SandboxClientFake.makeState()
    const bytes = new TextEncoder().encode("hello")

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SandboxClient.create({
          templateId: "rika-orb",
          envs: {},
          metadata,
          timeoutMs: 60_000,
        })
        yield* SandboxClient.writeFile("sandbox_1", "/tmp/hello.txt", bytes)
        const read = yield* SandboxClient.readFile("sandbox_1", "/tmp/hello.txt")
        const host = yield* SandboxClient.hostUrl("sandbox_1", 5173)
        return { read, host }
      }).pipe(Effect.provide(SandboxClientFake.layer(state))),
    )

    expect(new TextDecoder().decode(result.read)).toBe("hello")
    expect(result.host).toBe("https://sandbox_1-5173.fake.rika.local")
    expect(state.calls.writeFile).toEqual([{ sandboxId: "sandbox_1", path: "/tmp/hello.txt", bytes }])
    expect(state.calls.readFile).toEqual([{ sandboxId: "sandbox_1", path: "/tmp/hello.txt" }])
    expect(state.calls.hostUrl).toEqual([{ sandboxId: "sandbox_1", port: 5173 }])
  })

  test("create rejects missing required reverse-lookup metadata", async () => {
    const state = SandboxClientFake.makeState()

    const error = await Effect.runPromise(
      SandboxClient.create({
        templateId: "rika-orb",
        envs: {},
        metadata: { thread_id: "thread_only" },
        timeoutMs: 60_000,
      }).pipe(Effect.flip, Effect.provide(SandboxClientFake.layer(state))),
    )

    expect(error).toBeInstanceOf(SandboxClient.SandboxClientError)
    if (!(error instanceof SandboxClient.SandboxClientError)) throw new Error("expected SandboxClientError")
    expect(error.operation).toBe("create")
    expect(error.message).toContain("project_id")
  })

  test("create rejects empty reverse-lookup metadata", async () => {
    const state = SandboxClientFake.makeState()

    const error = await Effect.runPromise(
      SandboxClient.create({
        templateId: "rika-orb",
        envs: {},
        metadata: { thread_id: "", project_id: "project_orb_test" },
        timeoutMs: 60_000,
      }).pipe(Effect.flip, Effect.provide(SandboxClientFake.layer(state))),
    )

    expect(error).toBeInstanceOf(SandboxClient.SandboxClientError)
    if (!(error instanceof SandboxClient.SandboxClientError)) throw new Error("expected SandboxClientError")
    expect(error.operation).toBe("create")
    expect(error.message).toContain("thread_id")
  })

  test("live layer maps missing E2B_API_KEY to OrbConfigError", async () => {
    const error = await Effect.runPromise(
      SandboxClient.create({
        templateId: "rika-orb",
        envs: {},
        metadata,
        timeoutMs: 60_000,
      }).pipe(Effect.provide(SandboxClient.layer), Effect.provide(Config.layerFromValues(config)), Effect.flip),
    )

    expect(error).toBeInstanceOf(SandboxClient.OrbConfigError)
    if (!(error instanceof SandboxClient.OrbConfigError)) throw new Error("expected OrbConfigError")
    expect(error.key).toBe("E2B_API_KEY")
  })

  test("argv encoding preserves argument boundaries for the E2B shell command API", async () => {
    const command = await Effect.runPromise(
      SandboxClient.encodeArgvForShell(["printf", "%s", "hello world", "it's", "", "$(touch bad)"]),
    )

    expect(command).toBe("printf %s 'hello world' 'it'\\''s' '' '$(touch bad)'")
  })

  test("argv encoding rejects empty commands", async () => {
    const error = await Effect.runPromise(SandboxClient.encodeArgvForShell([], "sandbox_1").pipe(Effect.flip))

    expect(error).toBeInstanceOf(SandboxClient.SandboxClientError)
    if (!(error instanceof SandboxClient.SandboxClientError)) throw new Error("expected SandboxClientError")
    expect(error.operation).toBe("exec")
    expect(error.sandboxId).toBe("sandbox_1")
  })

  test("hostUrl normalizes raw E2B hosts into URLs", () => {
    expect(SandboxClient.urlFromHost("3000-sandbox.e2b.dev")).toBe("https://3000-sandbox.e2b.dev")
    expect(SandboxClient.urlFromHost("localhost:3000")).toBe("https://localhost:3000")
    expect(SandboxClient.urlFromHost("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
  })

  const integration = Bun.env.E2B_API_KEY === undefined || Bun.env.E2B_API_KEY.length === 0 ? test.skip : test

  integration("live layer creates a sandbox, executes echo, and kills it", async () => {
    const layer = SandboxClient.layer.pipe(Layer.provide(Config.layerFromEnv(process.env, process.cwd())))
    let sandboxId: string | undefined

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const created = yield* SandboxClient.create({
            templateId: Bun.env.RIKA_ORB_TEMPLATE ?? "base",
            envs: {},
            metadata: { ...metadata, purpose: "integration" },
            timeoutMs: 60_000,
          })
          sandboxId = created.sandboxId
          const chunks = yield* SandboxClient.exec(created.sandboxId, ["echo", "hi"], {}).pipe(Stream.runCollect)
          return { sandboxId: created.sandboxId, chunks: Array.from(chunks) }
        }).pipe(Effect.provide(layer)),
      )

      expect(result.chunks.some((chunk) => chunk.type === "stdout" && chunk.data.includes("hi"))).toBe(true)
      expect(result.chunks.at(-1)).toEqual({ type: "exit", exitCode: 0 })
    } finally {
      if (sandboxId !== undefined) {
        await Effect.runPromise(SandboxClient.kill(sandboxId).pipe(Effect.provide(layer))).catch(() => undefined)
      }
    }
  })
})
