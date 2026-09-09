import { BunCrypto } from "@effect/platform-bun"
/* oxlint-disable complexity -- the runtime scenario intentionally covers admission, execution, recovery, and retry in one durable flow. */
/* oxlint-disable max-lines -- the canonical materializer and its released Runtime qualification stay co-located. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- the provider wrapper preserves Generalist's overloaded LanguageModel service while observing the normalized call. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- overload-preserving provider wrappers require explicit service signatures. */
import { expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Ref, Schema } from "effect"
import { Agent, Approvals, ModelRegistry, Permissions, SkillCatalog, ToolContext } from "generalist"
import * as Components from "generalist/components"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { Host } from "generalist/host"
import { ChildAdmission, ExecutableResolver, LocalScheduler, RunStore } from "generalist/runtime"
import * as DurabilityTesting from "generalist/testing/durability"
import * as TestModel from "generalist/testing/model"
/* oxlint-disable effecttsgo/strict-effect-provide -- tests provide isolated service layers at each boundary. */
import { ChangeSettingsCommand, modelPin, SessionMaterialization, skillBodyIdentity, type ModelConfiguration } from "../src/contract"
import { makeSessionMaterializationComponent } from "../src/component"
import {
  ContextMaterializationError,
  activateSkill,
  attenuate,
  authorizeChild,
  composeChildSessionContext,
  composeSessionContext,
  discover,
  layer as contextLayer,
  modelLayer,
  guardedAgentChildrenLayer,
  SessionAuthorization,
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
    const changed = {
      ...initial,
      guidance: {
        ...initial.guidance,
        payload: {
          ...initial.guidance.payload,
          entries: initial.guidance.payload.entries.map((entry) => ({ ...entry, content: "changed" })),
        },
      },
    }
    const error = yield* Effect.flip(restore(changed)).pipe(
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
    expect(error.reason).toBe("content-missing")
    expect(initial.guidance.payload.entries.find((entry) => entry.path === "AGENTS.md")?.content).toBe("initial guidance")
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
    const compositionError = yield* Effect.flip(
      composeSessionContext(
        Agent.make({ name: "context", input: Schema.String, output: Schema.String }),
        missing,
      ),
    )
    expect(compositionError.reason).toBe("content-missing")
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
    expect(() =>
      transition(changed, {
        ...command,
        requestId: "settings-invalid",
        expectedRevision: changed.settingsRevision,
        model: { ...nextModel, settings: { options: { apiKey: "redacted" } } },
        modelPin: modelPin({ ...nextModel, settings: { options: { apiKey: "redacted" } } }),
      }),
    ).toThrow("credential")
    const child = yield* attenuate(changed, { allowedTools: [], allowedModels: [changed.modelPin], allowedCredentials: [] }).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(child).toEqual({ allowedTools: [], allowedModels: [changed.modelPin], allowedCredentials: [] })
    const currentAuthorization = {
      allowedTools: [],
      allowedModels: [changed.modelPin],
      allowedCredentials: changed.model.credentialRefs,
    }
    const authorizedChild = yield* authorizeChild(changed, currentAuthorization, {
      allowedTools: [],
      allowedModels: [changed.modelPin],
      allowedCredentials: changed.model.credentialRefs,
    }).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(authorizedChild.allowedCredentials).toEqual(changed.model.credentialRefs)
    const revokedChild = yield* Effect.flip(
      authorizeChild(
        changed,
        { ...currentAuthorization, allowedCredentials: [] },
        { allowedTools: [], allowedModels: [changed.modelPin], allowedCredentials: changed.model.credentialRefs },
      ).pipe(
        Effect.provide(
          contextLayer.pipe(
            Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
          ),
        ),
      ),
    )
    expect(revokedChild.reason).toBe("revoked")
    const childError = yield* Effect.flip(attenuate(changed, { allowedTools: ["ungranted"], allowedModels: [], allowedCredentials: [] })).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(childError.reason).toBe("attenuation")
    const credentialError = yield* Effect.flip(
      attenuate(changed, {
        allowedTools: [],
        allowedModels: [],
        allowedCredentials: [{ provider: "other", reference: "credential://other/value" }],
      }),
    ).pipe(
      Effect.provide(
        contextLayer.pipe(
          Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
        ),
      ),
    )
    expect(credentialError.reason).toBe("attenuation")
  }))

it.effect("registers session-owned materialization with the released Generalist component API", () =>
  Effect.gen(function* () {
    const initial = yield* discoverWith([])
    const declaration = makeSessionMaterializationComponent(initial)
    expect(declaration.registration.descriptor.scope).toBe("session")
    expect(declaration.registration.descriptor.access).toBe("session-owner")
    yield* Layer.build(Components.layer([declaration.registration]))
  }))

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const runtimeBinding = { workspaceId: "runtime-workspace", lineageId: "runtime-lineage", generation: "runtime-generation" } as const
const runtimeModel: ModelConfiguration = {
  selection: { provider: "test", model: "scripted" },
  settings: { temperature: 0.25, maxOutputTokens: 128, reasoningEffort: "low" },
  credentialRefs: [{ provider: "test", reference: "credential://test/token" }],
}

const initialMaterialization = () =>
  discover({
    sessionId: "runtime-session",
    guidanceScope: "runtime-session",
    binding: runtimeBinding,
    capturedAt: "2026-09-09T12:00:00.000Z",
    model: runtimeModel,
    tools: [],
  }).pipe(
    Effect.flatMap((materialization) =>
      activateSkill({
        materialization,
        requestId: "runtime-activate-skill",
        name: "runtime-skill",
        capturedAt: "2026-09-09T12:00:01.000Z",
      }),
    ),
    Effect.provide(
      contextLayer.pipe(
        Layer.provide(
          layerTest({
            readGuidance: () => Effect.succeed([{ path: "AGENTS.md", content: "runtime guidance" }]),
            listSkills: () =>
              Effect.succeed([
                {
                  name: "runtime-skill",
                  description: "Pinned runtime skill",
                  instructions: Effect.succeed("exact runtime skill body"),
                  tools: [],
                },
              ]),
          }),
        ),
      ),
    ),
  )

const runtimeLayer = (bucket: DurabilityTesting.Simulator) =>
  durabilityLayer({
    environment: "context-v2-test",
    tenant: "context-v2-owner",
    partition: "context-v2-session",
    addresses: [],
    schedulerMode: "external",
  }).pipe(
    Layer.provide(ExecutableResolver.layerStatic([])),
    Layer.provide(DurabilityTesting.layer(bucket)),
    Layer.provide(BunCrypto.layer),
  )

const configuredModelLayer = (fixture: TestModel.Fixture, configuration: ModelConfiguration, seen: Array<ModelConfiguration>) => {
  const languageModel = Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const base = yield* LanguageModel.LanguageModel
      return {
        ...base,
        /* SAFETY: This wrapper preserves the base overloaded LanguageModel method contract. */
        generateText: ((options: LanguageModel.ProviderOptions) => {
          seen.push(configuration)
          /* SAFETY: ProviderOptions is the normalized input accepted by the base service implementation. */
          return base.generateText(options as never)
        }) as LanguageModel.Service["generateText"],
        /* SAFETY: This wrapper preserves the base overloaded LanguageModel method contract. */
        streamText: ((options: LanguageModel.ProviderOptions) => {
          seen.push(configuration)
          /* SAFETY: ProviderOptions is the normalized input accepted by the base service implementation. */
          return base.streamText(options as never)
        }) as LanguageModel.Service["streamText"],
      }
    }).pipe(Effect.provide(fixture.layer)),
  )
  const registration =
    fixture.selection.registrationKey === undefined
      ? ModelRegistry.registration({ provider: fixture.selection.provider, model: fixture.selection.model, layer: languageModel })
      : ModelRegistry.registration({
          provider: fixture.selection.provider,
          model: fixture.selection.model,
          registrationKey: fixture.selection.registrationKey,
          layer: languageModel,
        })
  return ModelRegistry.layer([registration])
}

const runSettings = (
  bucket: DurabilityTesting.Simulator,
  initial: SessionMaterialization,
  modelScript: ReadonlyArray<TestModel.Step>,
  runKey: string,
  createSession: boolean,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* TestModel.make(modelScript)
      const modelCalls: Array<ModelConfiguration> = []
      const declaration = makeSessionMaterializationComponent(initial)
      const parameters = ChangeSettingsCommand
      const tool = Tool.make("change_context_settings", {
        description: "Apply one accepted model settings transition.",
        parameters,
        success: Schema.String,
        failure: Schema.String,
        failureMode: "return",
      }).annotate(Components.CommandTool, declaration.registration)
      const toolkit = Toolkit.make(tool)
      const baseAgent = Agent.make({
        name: "context",
        input: Schema.String,
        output: Schema.String,
        toolkit,
      })
      const composition = yield* composeSessionContext(baseAgent, initial)
      const agent = composition.agent
      const selectedModelLayer = yield* modelLayer(initial, (selected) => configuredModelLayer(fixture, selected, modelCalls))
      const handler = (command: typeof ChangeSettingsCommand.Type) =>
        Components.command(declaration, { id: command.requestId, command }).pipe(
          Effect.as("accepted"),
          Effect.mapError(String),
        )
      const runtime = runtimeLayer(bucket)
      return yield* Effect.gen(function* () {
        const host = yield* Host.make({ agents: { context: agent }, revision: "context-v2-test" })
        const activation = yield* activate
        return yield* Effect.gen(function* () {
          const session = createSession
            ? yield* host.sessions.create({ id: "runtime-session", agent: "context" })
            : yield* host.sessions.get("runtime-session")
          const run = yield* host.runs.start("runtime-session", agent, "apply settings", { idempotencyKey: runKey })
          const scheduler = yield* LocalScheduler.LocalScheduler
          yield* scheduler.drain({ fuel: 64 })
          const requests = yield* fixture.requests
          if (requests.length === 0) {
            yield* host.runs.cancel(run.id, `${runKey}:cancel`, "integration timeout")
            return yield* Effect.die(new Error("runtime emitted no model request"))
          }
          const output = yield* run.await
          const execution = yield* (yield* RunStore.RunStore).loadExecution(run.id)
          return { requests, host, session, output, execution, modelCalls }
        }).pipe(Effect.ensuring(Fiber.interrupt(activation)))
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            runtime,
            fixture.layer,
            selectedModelLayer,
            composition.instructions,
            Components.layer([declaration.registration]),
            Permissions.layerAllowAll,
            Approvals.layerAutoApprove,
            toolkit.toLayer({ change_context_settings: handler }),
          ),
        ),
      )
    }),
  )

it.effect("persists Session components across fresh Runtime layers and deduplicates command receipts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const initial = yield* initialMaterialization()
      const changedModel: ModelConfiguration = { ...runtimeModel, settings: { ...runtimeModel.settings, reasoningEffort: "high" } }
      const command = ChangeSettingsCommand.make({
        requestId: "settings-retry",
        expectedRevision: 0,
        model: changedModel,
        modelPin: modelPin(changedModel),
      })
      const first = yield* runSettings(
        bucket,
        initial,
        [TestModel.toolCall("change_context_settings", command), TestModel.text("first")],
        "run-settings-first",
        true,
      )
      expect(first.output).toBe("first")
      expect(encodeJson(first.requests[0]?.prompt)).toContain("runtime guidance")
      expect(encodeJson(first.requests[0]?.prompt)).toContain("exact runtime skill body")
      expect(first.modelCalls[0]?.settings).toMatchObject({ temperature: 0.25, maxOutputTokens: 128, reasoningEffort: "low" })
      expect(first.execution.sessionComponents?.[0]?.state).toMatchObject({ settingsRevision: 1, model: changedModel })
      expect(first.execution.sessionComponents?.[0]?.receipts).toHaveLength(1)
      const restored = yield* Schema.decodeUnknownEffect(SessionMaterialization)(first.execution.sessionComponents?.[0]?.state)
      const retry = yield* runSettings(
        bucket,
        restored,
        [TestModel.toolCall("change_context_settings", command), TestModel.text("retry")],
        "run-settings-retry",
        false,
      )
      expect(retry.output).toBe("retry")
      expect(encodeJson(retry.requests[0]?.prompt)).toContain("runtime guidance")
      expect(encodeJson(retry.requests[0]?.prompt)).toContain("exact runtime skill body")
      expect(retry.modelCalls[0]?.settings).toMatchObject({ temperature: 0.25, maxOutputTokens: 128, reasoningEffort: "high" })
      expect(retry.execution.sessionComponents?.[0]?.state).toMatchObject({ settingsRevision: 1, model: changedModel })
      expect(retry.execution.sessionComponents?.[0]?.receipts).toHaveLength(1)
      expect(encodeJson(retry.execution.sessionComponents?.[0]?.state)).not.toContain("secret-value")
    }),
  ))

it.effect("captures model input in the durable Run request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const initial = yield* initialMaterialization()
      const changedModel: ModelConfiguration = { ...runtimeModel, settings: { ...runtimeModel.settings, reasoningEffort: "high" } }
      const command = {
        _tag: "ChangeSettings" as const,
        requestId: "settings-input",
        expectedRevision: 0,
        model: changedModel,
        modelPin: modelPin(changedModel),
      }
      const result = yield* runSettings(
        bucket,
        initial,
        [TestModel.toolCall("change_context_settings", command), TestModel.text("input captured")],
        "run-settings-input",
        true,
      )
      expect(result.requests[0]?.prompt).toBeDefined()
      expect(encodeJson(result.requests[0]?.prompt)).toContain("apply settings")
      expect(encodeJson(result.execution.message.prompt)).toContain("apply settings")
      expect(result.modelCalls[0]?.settings).toMatchObject({ temperature: 0.25, maxOutputTokens: 128, reasoningEffort: "low" })
      expect(result.output).toBe("input captured")
    }),
  ))

it.effect("rejects child composition before the selected model layer when credentials are omitted", () =>
  Effect.gen(function* () {
    const materialization = yield* initialMaterialization()
    const authorization = {
      allowedTools: [],
      allowedModels: [materialization.modelPin],
      allowedCredentials: materialization.model.credentialRefs,
    }
    const requested = {
      allowedTools: [],
      allowedModels: [materialization.modelPin],
      allowedCredentials: [],
    }
    const child = Agent.make({ name: "child", input: Schema.String, output: Schema.String })
    let factoryCalls = 0
    const error = yield* Effect.flip(
      composeChildSessionContext(child, materialization, authorization, requested).pipe(
        Effect.flatMap(() =>
          modelLayer(materialization, () => {
            factoryCalls += 1
            return ModelRegistry.layer()
          }),
        ),
      ),
    )
    expect(error.reason).toBe("attenuation")
    expect(factoryCalls).toBe(0)
  }))

it.effect("gates durable child admission on current credential authorization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const fixture = yield* TestModel.make([TestModel.text("parent"), TestModel.text("child")])
      const materialization = yield* initialMaterialization()
      const parentBase = Agent.make({ name: "parent", input: Schema.String, output: Schema.String, children: ["child"] })
      const childBase = Agent.make({ name: "child", input: Schema.String, output: Schema.String })
      const parent = yield* composeSessionContext(parentBase, materialization)
      const child = yield* composeSessionContext(childBase, materialization)
      const authorization = {
        allowedTools: [],
        allowedModels: [materialization.modelPin],
        allowedCredentials: materialization.model.credentialRefs,
      }
      const request = {
        allowedTools: [],
        allowedModels: [materialization.modelPin],
        allowedCredentials: materialization.model.credentialRefs,
      }
      const runtime = runtimeLayer(bucket)
      yield* Effect.gen(function* () {
        const host = yield* Host.make({ agents: { parent: parent.agent, child: child.agent }, revision: "context-v2-child-test" })
        const activation = yield* activate
        yield* Effect.gen(function* () {
          const session = yield* host.sessions.create({ id: "runtime-parent", agent: "parent" })
          const parentRun = yield* host.runs.start(session.id, parent.agent, "parent", { idempotencyKey: "parent-run" })
          yield* authorizeChild(materialization, authorization, request).pipe(
            Effect.provide(
              contextLayer.pipe(
                Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
              ),
            ),
          )
          const childReceipt = yield* host.runs.admitChild(parentRun.id, "child", "child", { commandId: "child-1" })
          const scheduler = yield* LocalScheduler.LocalScheduler
          yield* scheduler.drain({ fuel: 64 })
          const childRun = yield* host.runs.get(childReceipt.runId)
          expect(yield* childRun.await).toBe("child")
          const denied = yield* Effect.flip(
            authorizeChild(
              materialization,
              { ...authorization, allowedCredentials: [] },
              request,
            ).pipe(
              Effect.provide(
                contextLayer.pipe(
                  Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
                ),
              ),
            ),
          )
          expect(denied.reason).toBe("revoked")
          const deniedModel = yield* Effect.flip(
            authorizeChild(
              materialization,
              { ...authorization, allowedModels: [] },
              request,
            ).pipe(
              Effect.provide(
                contextLayer.pipe(
                  Layer.provide(layerTest({ readGuidance: () => Effect.succeed([]), listSkills: () => Effect.succeed([]) })),
                ),
              ),
            ),
          )
          expect(deniedModel.reason).toBe("revoked")
          expect(yield* host.runs.children(parentRun.id)).toHaveLength(1)
        }).pipe(Effect.ensuring(Fiber.interrupt(activation)))
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            runtime,
            fixture.layer,
            fixture.registryLayer,
            parent.instructions,
            child.instructions,
            Permissions.layerAllowAll,
            Approvals.layerAutoApprove,
          ),
        ),
      )
    }),
  ))

it.effect("guards model-owned child admission through the Runtime AgentChildren service", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const fixture = yield* TestModel.make([
        TestModel.toolCall("spawn_child", { key: "child-1", prompt: "child", selection: "child" }),
        TestModel.toolCall("spawn_child", { key: "child-2", prompt: "child", selection: "child" }),
        TestModel.text("parent done"),
        TestModel.text("child done"),
      ])
      const materialization = yield* initialMaterialization()
      const authorization = {
        allowedTools: [],
        allowedModels: [materialization.modelPin],
        allowedCredentials: materialization.model.credentialRefs,
      }
      const revoked = { ...authorization, allowedCredentials: [] }
      const authorizationRef = yield* Ref.make(authorization)
      const declaration = makeSessionMaterializationComponent(materialization)
      const childTool = Tool.make("child_forbidden", {
        description: "A tool not granted to the child.",
        parameters: Schema.Struct({}),
        success: Schema.String,
        failure: Schema.String,
        failureMode: "return",
      })
      const spawnTool = Tool.make("spawn_child", {
        description: "Admit one durable child.",
        parameters: Schema.Struct({ key: Schema.String, prompt: Schema.String, selection: Schema.String }),
        success: Schema.String,
        failure: Schema.String,
        failureMode: "return",
        dependencies: [ChildAdmission.AgentChildren, ToolContext.ToolContext],
      })
      const parentToolkit = Toolkit.make(spawnTool)
      const parentBase = Agent.make({
        name: "parent",
        input: Schema.String,
        output: Schema.String,
        children: ["child"],
        toolkit: parentToolkit,
      })
      const childBase = Agent.make({
        name: "child",
        input: Schema.String,
        output: Schema.String,
        toolkit: Toolkit.make(childTool),
      })
      const parent = yield* composeSessionContext(parentBase, materialization)
      const child = yield* composeChildSessionContext(childBase, materialization, authorization, {
        allowedTools: [],
        allowedModels: [materialization.modelPin],
        allowedCredentials: materialization.model.credentialRefs,
      })
      const modelCalls: Array<ModelConfiguration> = []
      const selectedModelLayer = yield* modelLayer(materialization, (selected) => configuredModelLayer(fixture, selected, modelCalls))
      const authorizationLayer = Layer.succeed(SessionAuthorization, SessionAuthorization.of({ current: () => Ref.get(authorizationRef) }))
      const guardedChildren = guardedAgentChildrenLayer({
        declaration,
        children: {
          child: { allowedTools: [], allowedModels: [materialization.modelPin], allowedCredentials: materialization.model.credentialRefs },
        },
      })
      const spawnHandler = (input: { readonly key: string; readonly prompt: string; readonly selection: string }) =>
        Effect.gen(function* () {
          const service = yield* ChildAdmission.AgentChildren
          const receipt = yield* service.admit(input)
          yield* Ref.set(authorizationRef, revoked)
          return receipt.childRunId
        }).pipe(Effect.mapError(String))
      const runtime = runtimeLayer(bucket)
      const baseLayer = Layer.mergeAll(
        runtime,
        fixture.layer,
        selectedModelLayer,
        parent.instructions,
        child.instructions,
        Components.layer([declaration.registration]),
        authorizationLayer,
        Permissions.layerAllowAll,
        Approvals.layerAutoApprove,
        parentToolkit.toLayer({ spawn_child: spawnHandler }),
      )
      const environment = guardedChildren.pipe(Layer.provideMerge(baseLayer))
      yield* Effect.gen(function* () {
        const host = yield* Host.make({ agents: { parent: parent.agent, child: child.agent }, revision: "context-v2-children" })
        const activation = yield* activate
        yield* Effect.gen(function* () {
          const session = yield* host.sessions.create({ id: "runtime-parent-guarded", agent: "parent" })
          const run = yield* host.runs.start(session.id, parent.agent, "parent", { idempotencyKey: "parent-guarded" })
          const scheduler = yield* LocalScheduler.LocalScheduler
          yield* scheduler.drain({ fuel: 128 })
          const children = yield* host.runs.children(run.id)
          expect(children).toHaveLength(1)
          expect(modelCalls.length).toBeGreaterThan(0)
          const execution = yield* (yield* RunStore.RunStore).loadExecution(children[0]!.childRunId)
          const childEntry = execution.executableManifest.entries.find(
            (entry) => entry._tag === "Agent" && entry.pin === execution.executableRef.active,
          )
          expect(childEntry?._tag === "Agent" ? childEntry.manifest.tools : undefined).toHaveLength(0)
          expect(modelCalls.some((call) => call.selection.model === materialization.model.selection.model)).toBe(true)
        }).pipe(Effect.ensuring(Fiber.interrupt(activation)))
      }).pipe(
        Effect.provide(environment),
      )
    }),
  ))
