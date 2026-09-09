import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SkillCatalog } from "generalist"
import * as Components from "generalist/components"
/* oxlint-disable effecttsgo/strict-effect-provide -- tests provide isolated service layers at each boundary. */
import { ChangeSettingsCommand, modelPin, skillBodyIdentity, type ModelConfiguration } from "../src/contract"
import { makeSessionMaterializationComponent } from "../src/component"
import {
  ContextMaterializationError,
  activateSkill,
  attenuate,
  discover,
  layer as contextLayer,
  resolveAuthorization,
  restore,
  settingsReceipt,
  transition,
} from "../src/materializer"
import { layerTest } from "../src/workspace"

const binding = { workspaceId: "workspace-1", lineageId: "lineage-1", generation: "generation-1" } as const
const model: ModelConfiguration = {
  selection: { provider: "test", model: "test-model" },
  settings: { reasoningEffort: "low" },
  credentialRefs: [{ provider: "test", reference: "credential://test/model" }],
}

const makeSkill = (body: string, onRead: () => void): SkillCatalog.Skill => ({
  name: "review",
  description: "Review changes",
  instructions: Effect.sync(() => {
    onRead()
    return body
  }),
  tools: [],
})

const discoverWith = (skills: ReadonlyArray<SkillCatalog.Skill>, guidance = "initial guidance") =>
  discover({
      sessionId: "session-1",
      guidanceScope: "session-1/workspace",
      binding,
      capturedAt: "2026-09-09T12:00:00.000Z",
      model,
      tools: [],
    }).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(
            layerTest({
              readGuidance: () => Effect.succeed([{ path: "AGENTS.md", content: guidance }]),
              listSkills: () => Effect.succeed(skills),
            }),
          ),
        ),
      ),
    )

it.effect("captures workspace guidance from the explicit binding and retains it after changes", () =>
  Effect.gen(function* () {
    let reads = 0
    const initial = yield* discoverWith([makeSkill("old body", () => void reads++)])
    expect(reads).toBe(0)
    const changed = { ...initial, guidance: { ...initial.guidance, payload: { ...initial.guidance.payload, entries: initial.guidance.payload.entries.map((entry) => ({ ...entry, content: "changed" })) } } }
    const restored = yield* restore(initial).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(
            layerTest({
              readGuidance: () => Effect.succeed([{ path: "AGENTS.md", content: "deleted" }]),
              listSkills: () => Effect.succeed([]),
            }),
          ),
        ),
      ),
    )
    expect(restored.guidance.payload.entries.find((entry) => entry.path === "AGENTS.md")?.content).toBe("initial guidance")
    expect(changed.guidance.payload.entries.find((entry) => entry.path === "AGENTS.md")?.content).toBe("changed")
  }))

it.effect("advertises bounded skill metadata and captures the exact lazy body", () =>
  Effect.gen(function* () {
    let reads = 0
    const initial = yield* discoverWith([makeSkill("old body", () => void reads++)])
    expect(reads).toBe(0)
    const activated = yield* activateSkill({
      materialization: initial,
      requestId: "activation-1",
      name: "review",
      capturedAt: "2026-09-09T12:01:00.000Z",
    }).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(
            layerTest({
              readGuidance: () => Effect.succeed([]),
              listSkills: () => Effect.succeed([makeSkill("new body", () => void reads++)]),
            }),
          ),
        ),
      ),
    )
    expect(reads).toBe(1)
    expect(activated.activatedSkills[0]?.bodyIdentity).toEqual(skillBodyIdentity("new body"))
    expect(activated.guidance.payload.entries.find((entry) => entry.title === "review")?.content).toBe("new body")
    expect(initial.guidance.payload.entries.find((entry) => entry.title === "review")?.content).not.toBe("new body")
  }))

it.effect("fails closed when pinned guidance or activated content is missing", () =>
  Effect.gen(function* () {
    let reads = 0
    const initial = yield* discoverWith([makeSkill("body", () => void reads++)])
    const activated = yield* activateSkill({
      materialization: initial,
      requestId: "activation-1",
      name: "review",
      capturedAt: "2026-09-09T12:01:00.000Z",
    }).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(
            layerTest({
              readGuidance: () => Effect.succeed([]),
              listSkills: () => Effect.succeed([makeSkill("body", () => void reads++)]),
            }),
          ),
        ),
      ),
    )
    const missing = { ...activated, registration: { ...activated.registration, payload: { ...activated.registration.payload, entries: [] } } }
    const error = yield* Effect.flip(restore(missing)).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(error).toBeInstanceOf(ContextMaterializationError)
    expect(error.reason).toBe("content-missing")
  }))

it.effect("narrows revoked access without rewriting the pinned materialization", () =>
  Effect.gen(function* () {
    const initial = yield* discoverWith([])
    const authorization = yield* resolveAuthorization(initial, {
      allowedTools: [],
      allowedModels: [],
      allowedCredentials: [],
    }).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(authorization.canResume).toBe(false)
    expect(authorization.revokedModels).toEqual([initial.modelPin])
    expect(initial.model).toEqual(model)
  }))

it.effect("records settings changes through the canonical component transition and attenuates children", () =>
  Effect.gen(function* () {
    const initial = yield* discoverWith([])
    const nextModel = { ...model, settings: { reasoningEffort: "high" } }
    const command = ChangeSettingsCommand.make({
      requestId: "settings-1",
      expectedRevision: initial.settingsRevision,
      model: nextModel,
      modelPin: modelPin(nextModel),
    })
    const receipt = settingsReceipt(initial, command)
    const changed = transition(initial, command)
    expect(receipt).toEqual({ requestId: "settings-1", previousRevision: 0, revision: 1, modelPin: modelPin(nextModel) })
    expect(changed.settingsRevision).toBe(1)
    expect(() => transition(changed, command)).toThrow("Settings revision conflict")
    const child = yield* attenuate(changed, { allowedTools: [], allowedModels: [changed.modelPin] }).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(child).toEqual({ allowedTools: [], allowedModels: [changed.modelPin] })
    const childError = yield* Effect.flip(attenuate(changed, { allowedTools: ["ungranted"], allowedModels: [] })).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(childError.reason).toBe("attenuation")
  }))

it.effect("registers session-owned materialization with the released Generalist component API", () =>
  Effect.gen(function* () {
    const initial = yield* discoverWith([])
    const declaration = makeSessionMaterializationComponent(initial)
    expect(declaration.registration.descriptor.scope).toBe("session")
    expect(declaration.registration.descriptor.access).toBe("session-owner")
    yield* Layer.build(Components.layer([declaration.registration]))
  }))
