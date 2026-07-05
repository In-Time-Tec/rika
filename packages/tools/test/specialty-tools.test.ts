import { describe, expect, test } from "bun:test"
import { mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionPolicy, ToolExecutor } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { ArtifactStore } from "@rika/persistence"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { SpecialtyTools } from "../src/index"

const workspaceRoot = "/workspace/rika-specialty"
const now = Common.TimestampMillis.make(2_000_000_000_000)

const tempWorkspace = () => mkdtemp(join(tmpdir(), "rika-specialty-"))

const configLayer = (root = workspaceRoot) =>
  Config.layerFromValues({
    workspace_root: root,
    data_dir: `${root}/.rika`,
    default_mode: "smart",
  })

const diagnosticsLayer = () => {
  const redactorLayer = SecretRedactor.layer
  return Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
}

const call = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name}`),
  name,
  input,
  metadata: {
    thread_id: "thread_specialty",
    turn_id: "turn_specialty",
  },
})

const baseLayer = (root = workspaceRoot) =>
  Layer.mergeAll(configLayer(root), IdGenerator.sequenceLayer(1), Time.fixedLayer(now), ArtifactStore.fakeLayer())

const modelLayer = (responses: ReadonlyArray<Provider.FakeResponse>, root = workspaceRoot) =>
  modelLayerFromRegistry(
    Provider.fakeRegistryLayer([
      { name: "anthropic", responses },
      { name: "openai", responses },
    ]),
    root,
  )

const modelLayerFromProviders = (providers: ReadonlyArray<Provider.Interface>, root = workspaceRoot) =>
  modelLayerFromRegistry(Provider.registryLayerFromProviders(providers), root)

const modelLayerFromRegistry = (registryLayer: Layer.Layer<Provider.Registry>, root = workspaceRoot) =>
  SpecialtyTools.layer.pipe(
    Layer.provideMerge(baseLayer(root)),
    Layer.provideMerge(
      Router.layer.pipe(
        Layer.provideMerge(registryLayer),
        Layer.provideMerge(configLayer(root)),
        Layer.provideMerge(diagnosticsLayer()),
      ),
    ),
  )

describe("SpecialtyTools", () => {
  test("oracle uses the model-routed provider, returns structured findings, and persists a research artifact", async () => {
    const response = JSON.stringify({
      answer: "Use a smaller seam.",
      findings: [
        {
          severity: "high",
          title: "Layer boundary is leaky",
          evidence: "The adapter leaks provider details.",
          recommendation: "Move provider details behind @rika/llm.",
        },
      ],
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const output = yield* SpecialtyTools.oracle({ task: "Review this design" }, call("oracle", { task: "Review" }))
        const stored = yield* ArtifactStore.get(Ids.ArtifactId.make(String(object(output).artifact_id)))
        return { output: object(output), stored }
      }).pipe(Effect.provide(modelLayer([response]))),
    )

    expect(result.output).toMatchObject({
      type: "specialty.oracle",
      answer: "Use a smaller seam.",
      artifact_id: "artifact_1",
      model: "gpt-5.5",
    })
    expect(object(array(result.output.findings)[0])).toMatchObject({
      severity: "high",
      title: "Layer boundary is leaky",
    })
    const artifact = Option.getOrUndefined(result.stored)
    expect(artifact).toMatchObject({
      id: "artifact_1",
      thread_id: "thread_specialty",
      turn_id: "turn_specialty",
      kind: "research",
      title: "Oracle second opinion",
      metadata: { tool: "oracle", findings: 1 },
    })
  })

  test("oracle preserves the answer-only fallback for invalid structured output", async () => {
    const output = object(
      await Effect.runPromise(
        SpecialtyTools.oracle({ task: "Review this design" }, call("oracle", { task: "Review" })).pipe(
          Effect.provide(modelLayer(["plain second opinion"])),
        ),
      ),
    )

    expect(output).toMatchObject({
      type: "specialty.oracle",
      answer: "plain second opinion",
      artifact_id: "artifact_1",
    })
    expect(output.findings).toEqual([])
  })

  test("librarian keeps external research separate from local search output and records citations", async () => {
    const output = object(
      await Effect.runPromise(
        SpecialtyTools.librarian(
          { question: "How does routing work?", repository: "github.com/example/framework" },
          call("librarian", { question: "How does routing work?" }),
        ).pipe(
          Effect.provide(
            modelLayer([
              JSON.stringify({
                answer: "The router maps paths before handlers run.",
                citations: [
                  {
                    title: "router.ts",
                    repository: "github.com/example/framework",
                    path: "src/router.ts",
                    line_start: 10,
                    line_end: 20,
                    excerpt: "match route before handler",
                  },
                ],
              }),
            ]),
          ),
        ),
      ),
    )

    expect(output).toMatchObject({ type: "specialty.librarian", artifact_id: "artifact_1" })
    expect(object(array(output.citations)[0])).toMatchObject({
      repository: "github.com/example/framework",
      path: "src/router.ts",
      line_start: 10,
    })
  })

  test("librarian fails on invalid structured model output instead of silently falling back", async () => {
    const error = await Effect.runPromise(
      SpecialtyTools.librarian(
        { question: "How does routing work?", repository: "github.com/example/framework" },
        call("librarian", { question: "How does routing work?" }),
      ).pipe(Effect.provide(modelLayer(["not json"])), Effect.flip),
    )

    expect(error).toBeInstanceOf(SpecialtyTools.SpecialtyToolsError)
    expect(error.operation).toBe("librarian")
  })

  test("specialty errors classify transient provider failures as retryable", async () => {
    const error = await Effect.runPromise(
      SpecialtyTools.librarian(
        { question: "How does routing work?", repository: "github.com/example/framework" },
        call("librarian", { question: "How does routing work?" }),
      ).pipe(
        Effect.provide(modelLayerFromProviders([failingProvider(aiError(new AiError.RateLimitError({})))])),
        Effect.flip,
      ),
    )

    expect(error.retryable).toBe(true)
  })

  test("specialty errors classify non-transient provider failures as non-retryable", async () => {
    const error = await Effect.runPromise(
      SpecialtyTools.librarian(
        { question: "How does routing work?", repository: "github.com/example/framework" },
        call("librarian", { question: "How does routing work?" }),
      ).pipe(
        Effect.provide(
          modelLayerFromProviders([failingProvider(aiError(new AiError.AuthenticationError({ kind: "InvalidKey" })))]),
        ),
        Effect.flip,
      ),
    )

    expect(error.retryable).toBe(false)
  })

  test("painter is opt-in, artifact-backed, and backend-swappable", async () => {
    const layer = SpecialtyTools.layerWithBackend({
      oracle: () => Effect.succeed({ answer: "unused", findings: [] }),
      librarian: () => Effect.succeed({ answer: "unused", citations: [] }),
      painter: (input) =>
        Effect.succeed({
          prompt: input.prompt,
          images: [{ mime_type: "image/png", data_url: "data:image/png;base64,ZmFrZQ==" }],
          model: "fake-image-backend",
        }),
    }).pipe(Layer.provideMerge(baseLayer()))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const output = yield* SpecialtyTools.painter(
          { prompt: "1024x1024 app icon", input_image_paths: ["brand.png"] },
          call("painter", { prompt: "1024x1024 app icon" }),
        )
        const stored = yield* ArtifactStore.get(Ids.ArtifactId.make(String(object(output).artifact_id)))
        return { output: object(output), stored }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output).toMatchObject({ type: "specialty.painter", artifact_id: "artifact_1" })
    expect(object(array(result.output.images)[0])).toMatchObject({ mime_type: "image/png" })
    expect(Option.getOrUndefined(result.stored)).toMatchObject({
      kind: "image",
      metadata: { tool: "painter", images: 1 },
    })
  })

  test("painter attaches workspace reference image bytes to the model request", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "brand.png"), Buffer.from("png-reference"))
    const capturedMessages: Array<ReadonlyArray<Provider.Message>> = []
    const provider = (name: Provider.ProviderName): Provider.Interface => ({
      name,
      complete: () => Effect.succeed({ provider: name, model: "unused", content: "unused", finish_reason: "stop" }),
      completeStructured: <A extends Record<string, any>>(request: Provider.StructuredRequest<A>) =>
        Effect.sync(() => {
          capturedMessages.push(request.messages)
          return {
            value: Schema.decodeUnknownSync(request.schema)({
              prompt: "paint with reference",
              images: [{ mime_type: "image/png", data_url: "data:image/png;base64,ZmFrZQ==" }],
            }),
            raw: { provider: name, model: request.model, content: "{}" },
          }
        }),
      stream: () => Stream.empty,
    })

    const output = object(
      await Effect.runPromise(
        SpecialtyTools.painter(
          { prompt: "Use the reference image", input_image_paths: ["brand.png"] },
          call("painter", { prompt: "Use the reference image" }),
        ).pipe(Effect.provide(modelLayerFromProviders([provider("anthropic"), provider("openai")], root))),
      ),
    )

    const message = capturedMessages[0]?.[1]
    if (message === undefined || typeof message.content === "string") throw new Error("Expected image message parts")
    expect(output).toMatchObject({ type: "specialty.painter", artifact_id: "artifact_1" })
    expect(message.content).toEqual([
      {
        type: "text",
        text: "Prompt:\nUse the reference image\n\nReference image paths:\n- brand.png",
      },
      {
        type: "file",
        media_type: "image/png",
        data: Buffer.from("png-reference").toString("base64"),
        filename: "brand.png",
      },
    ])
  })

  test("painter rejects reference image symlinks that escape the workspace", async () => {
    const root = await tempWorkspace()
    const outside = await tempWorkspace()
    await writeFile(join(outside, "secret.png"), Buffer.from("outside"))
    await symlink(join(outside, "secret.png"), join(root, "linked.png"))

    const error = await Effect.runPromise(
      SpecialtyTools.painter(
        { prompt: "Use the reference image", input_image_paths: ["linked.png"] },
        call("painter", { prompt: "Use the reference image" }),
      ).pipe(Effect.provide(modelLayer(['{"prompt":"unused","images":[]}'], root)), Effect.flip),
    )

    expect(error).toMatchObject({ operation: "painterReferenceImage", retryable: false })
    expect(error.message).toContain("outside the workspace")
  })

  test("painter rejects oversized reference images before reading bytes", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "huge.png"), Buffer.alloc(8_000_001))

    const error = await Effect.runPromise(
      SpecialtyTools.painter(
        { prompt: "Use the reference image", input_image_paths: ["huge.png"] },
        call("painter", { prompt: "Use the reference image" }),
      ).pipe(Effect.provide(modelLayer(['{"prompt":"unused","images":[]}'], root)), Effect.flip),
    )

    expect(error).toMatchObject({ operation: "painterReferenceImage", retryable: false })
    expect(error.message).toContain("exceeds 8000000 bytes")
  })

  test("specialty tools still pass through normal permission policy", async () => {
    let called = false
    const executorLayer = ToolExecutor.layer.pipe(
      Layer.provideMerge(
        SpecialtyTools.registryLayerFromService.pipe(
          Layer.provideMerge(
            SpecialtyTools.fakeLayer({
              oracle: () =>
                Effect.sync(() => {
                  called = true
                  return { answer: "should not run", findings: [] }
                }),
            }),
          ),
          Layer.provideMerge(baseLayer()),
        ),
      ),
      Layer.provideMerge(PermissionPolicy.rejectLayer("specialty calls disabled")),
      Layer.provideMerge(diagnosticsLayer()),
    )

    const result = await Effect.runPromise(
      ToolExecutor.execute(call("oracle", { task: "Review" })).pipe(Effect.provide(executorLayer)),
    )

    expect(called).toBe(false)
    expect(result).toMatchObject({
      status: "error",
      error: { kind: "permission", message: "specialty calls disabled" },
    })
  })
})

const object = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) return value
  throw new Error(`Expected object, got ${typeof value}`)
}

const array = (value: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value
  throw new Error(`Expected array, got ${typeof value}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const aiError = (reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module: "LanguageModel", method: "generateObject", reason })

const failingProvider = (error: Provider.ProviderError): Provider.Interface => ({
  name: "openai",
  complete: () => Effect.fail(error),
  completeStructured: () => Effect.fail(error),
  stream: () => Stream.fail(error),
})
