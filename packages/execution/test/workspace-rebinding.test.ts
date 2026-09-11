import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { WorkspaceBinding, WorkspaceComponentState, workspaceComponent } from "../src"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace", assignmentId: "assignment-1", generation: 1,
  placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
  buildId: "build", protocolVersion: 1,
})
const recovered = Schema.decodeSync(WorkspaceBinding)({ ...binding, assignmentId: "assignment-2", generation: 2 })
const bind = (state: WorkspaceComponentState, requested: WorkspaceBinding) =>
  workspaceComponent.registration.transition(
    Schema.encodeSync(Schema.Json)(state),
    Schema.encodeSync(Schema.Json)({ _tag: "Bind", binding: requested }),
  )

it.effect("preserves unresolved admissions instead of erasing them during a generation change", () =>
  Effect.gen(function* () {
    const admitted = [{ operationId: "uncertain-operation", tool: "bash", inputDigest: "input", binding }]
    const state = { binding, admitted }
    expect(yield* bind(state, binding)).toEqual(state)
    expect(yield* Effect.result(bind(state, recovered))).toMatchObject({ _tag: "Failure" })
    expect(state.admitted).toEqual(admitted)
    expect(yield* bind({ binding, admitted: [] }, recovered)).toEqual({ binding: recovered, admitted: [] })
    const changed = yield* Schema.decodeEffect(WorkspaceBinding)({ ...recovered, buildId: "replacement" })
    expect(yield* Effect.result(bind({ binding, admitted: [] }, changed))).toMatchObject({ _tag: "Failure" })
  }),
)
