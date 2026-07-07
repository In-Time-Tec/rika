import { describe, expect, test } from "bun:test"
import { ArtifactStore, Database, Migration } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Config, IdGenerator, Time } from "@rika/core"
import { Effect, Layer, Option } from "effect"
import { CheckRegistry, ReviewService, SubagentRuntime } from "../src/index"

const workspaceRoot = "/repo"
const now = Common.TimestampMillis.make(2_000_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: workspaceRoot,
  data_dir: `${workspaceRoot}/.rika`,
  default_mode: "smart",
})

const check = (name: string): CheckRegistry.Check => ({
  summary: {
    name,
    severity_default: "high",
    tools: ["read"],
    source_path: `.agents/checks/${name}.md`,
    scope_path: "",
    applies_to: [],
  },
  instructions: `Run ${name}.`,
})

const diffProvider: ReviewService.DiffProvider = () =>
  Effect.succeed({
    range: { kind: "working-tree", paths: [] },
    changed_files: ["src/app.ts"],
    diff: "diff --git a/src/app.ts b/src/app.ts\n+eval(input)",
    truncated: false,
  })

const makeLayer = (
  checks: ReadonlyArray<CheckRegistry.Check>,
  subagentHandler: SubagentRuntime.Interface["runBatch"],
  provider = diffProvider,
) =>
  ReviewService.layerWithDiffProvider(provider).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    Layer.provideMerge(Time.fixedLayer(now)),
    Layer.provideMerge(ArtifactStore.fakeLayer()),
    Layer.provideMerge(CheckRegistry.fakeLayer(checks)),
    Layer.provideMerge(SubagentRuntime.fakeLayer(subagentHandler)),
  )

const makeLiveArtifactLayer = () => {
  const databaseLayer = Database.memoryLayer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  return ReviewService.layerWithDiffProvider(diffProvider).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(Migration.layer),
    Layer.provideMerge(artifactLayer),
    Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    Layer.provideMerge(Time.fixedLayer(now)),
    Layer.provideMerge(CheckRegistry.fakeLayer([])),
    Layer.provideMerge(
      SubagentRuntime.fakeLayer(() => Effect.die(new Error("review subagents should not run without checks"))),
    ),
  )
}

describe("ReviewService", () => {
  test("runs checks against a diff, validates and dedupes findings, and stores a review artifact", async () => {
    const subagentInputs: Array<SubagentRuntime.RunBatchInput> = []
    const layer = makeLayer([check("security")], (input) =>
      Effect.sync(() => {
        subagentInputs.push(input)
        return {
          type: "subagent.batch" as const,
          runs: input.agents.map((agent, index) => ({
            subagent_id: `subagent_${index + 1}`,
            name: agent.name ?? `subagent-${index + 1}`,
            status: "completed" as const,
            summary: JSON.stringify({
              findings: [
                {
                  severity: "critical",
                  path: "src/app.ts",
                  range: { start_line: 1, end_line: 1 },
                  title: "Avoid eval",
                  evidence: "eval(input)",
                  recommendation: "Parse allowed operations explicitly.",
                },
                {
                  severity: "critical",
                  path: "src/app.ts",
                  range: { start_line: 1, end_line: 1 },
                  title: "Avoid eval",
                  evidence: "duplicate",
                },
                {
                  path: "README.md",
                  range: { start_line: 1, end_line: 1 },
                  title: "Ignored non-changed file",
                  evidence: "outside diff",
                },
              ],
            }),
            evidence: [],
            tool_access: agent.tool_access ?? "read-only",
            tool_names: agent.tool_names ?? [],
            started_at: now,
            completed_at: now,
          })),
        }
      }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const review = yield* ReviewService.run({})
        const stored = yield* ArtifactStore.get(review.artifact.id)
        return { review, stored }
      }).pipe(Effect.provide(layer)),
    )

    expect(subagentInputs).toHaveLength(1)
    expect(subagentInputs[0]?.agents[0]).toMatchObject({
      name: "review:security",
      tool_access: "read-only",
      tool_names: ["read"],
    })
    expect(result.review.run).toMatchObject({
      review_id: "review_1",
      thread_id: "thread_2",
      artifact_id: "artifact_3",
      status: "completed",
      changed_files: ["src/app.ts"],
      findings: [
        {
          check_name: "security",
          severity: "critical",
          path: "src/app.ts",
          range: { start_line: 1, end_line: 1 },
          title: "Avoid eval",
          evidence: "duplicate",
        },
      ],
    })
    expect(Option.getOrUndefined(result.stored)).toEqual(result.review.artifact)
  })

  test("reports no_changes without running check subagents", async () => {
    let called = false
    const layer = makeLayer(
      [check("security")],
      () =>
        Effect.sync(() => {
          called = true
          return { type: "subagent.batch", runs: [] }
        }),
      () =>
        Effect.succeed({ range: { kind: "working-tree", paths: [] }, changed_files: [], diff: "", truncated: false }),
    )

    const result = await Effect.runPromise(ReviewService.run({}).pipe(Effect.provide(layer)))

    expect(called).toBe(false)
    expect(result.run.status).toBe("no_changes")
    expect(result.run.findings).toEqual([])
  })

  test("stores review artifacts in the configured workspace for scoped listing", async () => {
    const workspaceId = Ids.WorkspaceId.make(workspaceRoot)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const review = yield* ReviewService.run({})
        const listed = yield* ArtifactStore.listAll({
          workspace_id: workspaceId,
          kind: "review",
        })
        return { review, listed }
      }).pipe(Effect.provide(makeLiveArtifactLayer())),
    )

    expect(result.review.artifact.workspace_id).toBe(workspaceId)
    expect(result.listed).toEqual([result.review.artifact])
  })
})
