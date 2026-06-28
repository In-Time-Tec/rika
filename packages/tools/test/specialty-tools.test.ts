import { describe, expect, test } from "bun:test"
import { PermissionPolicy, ToolExecutor } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { ArtifactStore } from "@rika/persistence"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Layer, Option } from "effect"
import { SpecialtyTools } from "../src/index"

const workspaceRoot = "/workspace/rika-specialty"
const now = Common.TimestampMillis.make(2_000_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: workspaceRoot,
  data_dir: `${workspaceRoot}/.rika`,
  default_mode: "smart",
})

const call = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name}`),
  name,
  input,
  metadata: {
    thread_id: "thread_specialty",
    turn_id: "turn_specialty",
  },
})

const baseLayer = () =>
  Layer.mergeAll(configLayer, IdGenerator.sequenceLayer(1), Time.fixedLayer(now), ArtifactStore.fakeLayer())

const modelLayer = (responses: ReadonlyArray<Provider.FakeResponse>) =>
  SpecialtyTools.layer.pipe(
    Layer.provideMerge(baseLayer()),
    Layer.provideMerge(
      Router.layer.pipe(Layer.provideMerge(Provider.fakeLayer(responses)), Layer.provideMerge(configLayer)),
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
