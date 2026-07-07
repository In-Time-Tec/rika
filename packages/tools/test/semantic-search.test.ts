import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionPolicy, ToolExecutor } from "@rika/agent"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Layer } from "effect"
import { SemanticSearch } from "../src/index"

const tempWorkspace = () => mkdtemp(join(tmpdir(), "rika-semantic-"))

const configLayer = (workspaceRoot: string, env: Record<string, string | undefined> = {}) =>
  Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: join(workspaceRoot, ".rika"),
      default_mode: "smart",
    },
    env,
  )

const diagnosticsLayer = () => {
  const redactorLayer = SecretRedactor.layer
  return Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
}

const fakeHits: ReadonlyArray<SemanticSearch.Hit> = [
  {
    id: "hit_auth",
    source: "code",
    path: "src/auth/session.ts",
    language: "typescript",
    kind: "code",
    symbol: "validateSession",
    startLine: 10,
    endLine: 14,
    snippet: "10: export function validateSession(token: string) {\n11:   return token.length > 0\n12: }",
    score: 0.98,
    sources: ["semantic", "text"],
  },
  {
    id: "hit_docs",
    source: "docs",
    path: "docs/auth.md",
    language: "markdown",
    kind: "docs",
    symbol: "",
    startLine: 1,
    endLine: 3,
    snippet: "1: # Auth\n2: Session validation docs",
    score: 0.72,
    sources: ["semantic"],
  },
]

const runFake = <A, E>(effect: Effect.Effect<A, E, SemanticSearch.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SemanticSearch.fakeLayer({ hits: fakeHits }))))

const runLive = <A, E>(
  workspaceRoot: string,
  effect: Effect.Effect<A, E, SemanticSearch.Service>,
  env: Record<string, string | undefined> = {},
) =>
  Effect.runPromise(effect.pipe(Effect.provide(SemanticSearch.layer), Effect.provide(configLayer(workspaceRoot, env))))

const call = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name}`),
  name,
  input,
})

describe("SemanticSearch", () => {
  test("fake layer returns ranked semantic_search output through the service boundary", async () => {
    const output = object(
      await runFake(
        SemanticSearch.search({
          query: "where do we validate session tokens",
          mode: "hybrid",
          pathPrefix: "src/",
          language: "typescript",
          limit: 1,
        }),
      ),
    )

    expect(output).toMatchObject({ type: "semantic_search", backend: "fake", mode: "hybrid", returned: 1 })
    expect(object(array(output.hits)[0])).toMatchObject({
      path: "src/auth/session.ts",
      start_line: 10,
      end_line: 14,
    })
    expect(String(output.content)).toContain("src/auth/session.ts:10-14")
  })

  test("file history mode is exposed through the same semantic_search tool shape", async () => {
    const output = object(
      await Effect.runPromise(
        SemanticSearch.search({ file: "src/auth/session.ts", lines: "10-14" }).pipe(
          Effect.provide(
            SemanticSearch.fakeLayer({
              hits: fakeHits,
              histories: { "src/auth/session.ts": "=== commit abc123 ===\nAdd session validation" },
            }),
          ),
        ),
      ),
    )

    expect(output).toMatchObject({
      type: "semantic_search.history",
      backend: "fake",
      file: "src/auth/session.ts",
      lines: "10-14",
    })
    expect(String(output.content)).toContain("Add session validation")
  })

  test("live layer honestly reports local lexical fallback and still searches local files", async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, "src", "auth"), { recursive: true })
    await writeFile(
      join(root, "src", "auth", "session.ts"),
      "export function validateToken(header: string) {\n  return header.startsWith('Bearer ')\n}\n",
    )

    const status = object(await runLive(root, SemanticSearch.status()))
    const output = object(
      await runLive(root, SemanticSearch.search({ query: "validate token", language: "typescript" })),
    )

    expect(status).toMatchObject({ type: "semantic_search_status", backend: "local", degraded: true })
    expect(status.missing_configuration).toBeUndefined()
    expect(output).toMatchObject({ type: "semantic_search", backend: "local", degraded: true })
    expect(object(array(output.hits)[0])).toMatchObject({ path: "src/auth/session.ts", language: "typescript" })
    expect(String(output.degraded_reason)).toContain("local lexical/token overlap search")
  })

  test("configured vector-related credentials do not claim a vector backend when only local search is wired", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "tool.ts"), "export const semanticStatus = 'local'\n")

    const status = object(
      await runLive(root, SemanticSearch.status(), {
        OPENROUTER_API_KEY: "openrouter-test-key",
        TURBOPUFFER_API_KEY: "turbopuffer-test-key",
        RIKA_EMBEDDINGS_API_KEY: "embeddings-test-key",
      }),
    )
    const output = object(
      await runLive(root, SemanticSearch.search({ query: "semantic status", language: "typescript" }), {
        OPENROUTER_API_KEY: "openrouter-test-key",
        TURBOPUFFER_API_KEY: "turbopuffer-test-key",
        RIKA_EMBEDDINGS_API_KEY: "embeddings-test-key",
      }),
    )

    expect(status).toMatchObject({ backend: "local", degraded: true })
    expect(status.missing_configuration).toBeUndefined()
    expect(String(status.degraded_reason)).toContain("no live vector backend is wired")
    expect(output).toMatchObject({ backend: "local", degraded: true })
    expect(object(array(output.hits)[0])).toMatchObject({ path: "tool.ts" })
  })

  test("tool execution validates missing query and reports a structured error", async () => {
    const registryLayer = SemanticSearch.registryLayerFromService.pipe(
      Layer.provideMerge(SemanticSearch.fakeLayer({ hits: fakeHits })),
    )
    const executorLayer = ToolExecutor.layer.pipe(
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(PermissionPolicy.allowLayer),
      Layer.provideMerge(diagnosticsLayer()),
    )

    const descriptors = await Effect.runPromise(ToolExecutor.describe().pipe(Effect.provide(executorLayer)))
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("semantic_search", {})).pipe(Effect.provide(executorLayer)),
    )

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(["semantic_search", "semantic_search_status"])
    expect(result).toMatchObject({
      status: "error",
      error: { message: "semantic_search requires query, queries, or file" },
    })
  })

  test("file history rejects paths outside the workspace", async () => {
    const root = await tempWorkspace()
    const error = await Effect.runPromise(
      SemanticSearch.search({ file: "../outside.ts" }).pipe(
        Effect.flip,
        Effect.provide(SemanticSearch.layer),
        Effect.provide(configLayer(root)),
      ),
    )

    expect(error).toMatchObject({ code: "E_PATH_OUTSIDE_WORKSPACE" })
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
