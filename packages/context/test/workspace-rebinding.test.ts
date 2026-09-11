import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { WorkspaceBinding } from "@rika/execution"
import { makeContextMaterializer, transition } from "../src/materializer"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace", assignmentId: "assignment-1", generation: 1,
  placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
  buildId: "build", protocolVersion: 1,
})

it.effect("changes only the workspace fence while retaining guidance, model, skills and tool authority", () =>
  Effect.gen(function* () {
    const materialization = yield* makeContextMaterializer({
      readGuidance: () => Effect.succeed([{ path: "AGENTS.md", content: "Pinned guidance" }]),
      listSkills: () => Effect.succeed([]),
    }).discover({
      sessionId: "session", guidanceScope: "workspace", binding, capturedAt: "2026-09-10T00:00:00.000Z",
      model: { selection: { provider: "test", model: "scripted" }, settings: {}, credentialRefs: [] },
      tools: [{ name: "bash", pin: "pinned-tool" }],
    })
    const recovered = yield* Schema.decodeEffect(WorkspaceBinding)({ ...binding, assignmentId: "assignment-2", generation: 2 })
    const next = transition(materialization, { _tag: "RebindWorkspace", expected: binding, workspace: recovered })
    expect(next).toEqual({ ...materialization, workspace: recovered })
    for (const changed of [binding, { ...recovered, buildId: "other" }, { ...recovered, protocolVersion: 2 }]) {
      const workspace = yield* Schema.decodeEffect(WorkspaceBinding)(changed)
      expect(() => transition(materialization, { _tag: "RebindWorkspace", expected: binding, workspace })).toThrow()
    }
    expect(() => transition(next, { _tag: "RebindWorkspace", expected: binding, workspace: recovered })).toThrow()
  }),
)
