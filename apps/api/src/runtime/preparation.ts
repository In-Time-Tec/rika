import { Effect, Layer, Option, Schema } from "effect"
import { Agent, NestedOperation, Pins, ToolContext } from "generalist"
import * as Components from "generalist/components"
import * as Hooks from "generalist/hooks"
import { RunStore } from "generalist/runtime"
import { WorkspaceBinding, sameBinding, sameWorkspacePolicy, type WorkspaceExecutorService } from "@rika/execution"
import {
  ContextMaterializationError,
  SessionMaterialization,
  composeSessionContext,
  deferredSessionMaterializationComponent,
  effectiveAuthorization,
  type SessionAuthorizationService,
} from "@rika/context"
import type { RuntimeWorkspace } from "./workspace"
import { assertWorkspaceRecoverable } from "./workspace-recovery"

export interface SessionPreparationInput {
  readonly sessionId: string
  readonly runId: string
  readonly acceptedInputId: string
  readonly admittedAt: string
  readonly operationKey: string
  readonly beforeRecovery: Effect.Effect<void, ContextMaterializationError>
}

export type PrepareSessionContext = (input: SessionPreparationInput) => Effect.Effect<
  SessionMaterialization,
  ContextMaterializationError | NestedOperation.Failure,
  NestedOperation.Operations | ToolContext.ToolContext
>

export type EnsureSessionWorkspace = (input: SessionPreparationInput) => Effect.Effect<
  WorkspaceBinding,
  ContextMaterializationError | NestedOperation.Failure,
  NestedOperation.Operations | ToolContext.ToolContext
>

const rejected = () =>
  ContextMaterializationError.make({
    reason: "binding",
    message: "Prepared context does not match the admitted Session policy",
  })

const matchesPolicy = (materialization: SessionMaterialization, policy: SessionMaterialization, binding: WorkspaceBinding) =>
  materialization.sessionId === policy.sessionId &&
  materialization.guidanceScope === policy.guidanceScope &&
  sameBinding(materialization.workspace, binding) &&
  Pins.digest(materialization.model) === Pins.digest(policy.model) &&
  materialization.modelPin === policy.modelPin &&
  materialization.settingsRevision === policy.settingsRevision &&
  Pins.digest(materialization.tools) === Pins.digest(policy.tools)

export const preparationLayer = (options: {
  readonly agent: Agent.Any
  readonly policy: SessionMaterialization
  readonly authorization: SessionAuthorizationService
  readonly prepare: PrepareSessionContext
  readonly workspace: WorkspaceExecutorService
  readonly ensureWorkspace: EnsureSessionWorkspace | undefined
  readonly rebindWorkspace: RuntimeWorkspace["rebind"] | undefined
}): Layer.Layer<Hooks.Hooks, never, RunStore.RunStore | Hooks.Hooks> =>
  Layer.effect(
    Hooks.Hooks,
    Effect.gen(function* () {
      const store = yield* RunStore.RunStore
      const existing = yield* Hooks.Hooks
      const declaration = deferredSessionMaterializationComponent
      return Hooks.make({
        declarations: [
          ...existing.declarations,
          Hooks.onRunStart({
            key: "rika.session.prepare",
            version: "1",
            replayPolicy: "provider-idempotent",
            hook: (input, hook) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const execution = yield* store.loadExecution(input.runId)
                  if (
                    execution.message.sessionId !== options.policy.sessionId ||
                    input.agentName !== options.agent.name
                  )
                    return yield* rejected()
                  const authorization = yield* options.authorization.current(options.policy.sessionId)
                  if (!(yield* effectiveAuthorization(options.policy, authorization)).canResume)
                    return yield* ContextMaterializationError.make({
                      reason: "revoked",
                      message: "Session preparation is not authorized",
                    })
                  const operations = yield* Effect.serviceOption(NestedOperation.Operations)
                  if (Option.isNone(operations)) return yield* rejected()
                  const signal = yield* Effect.abortSignal
                  const preparation: SessionPreparationInput = {
                    sessionId: execution.message.sessionId,
                    runId: input.runId,
                    acceptedInputId: execution.message.id,
                    admittedAt: execution.admittedAt,
                    operationKey: hook.operationKey,
                    beforeRecovery: assertWorkspaceRecoverable({ store, sessionId: execution.message.sessionId, runId: input.runId }),
                  }
                  const workspacePolicy = {
                    workspaceId: options.policy.workspace.workspaceId,
                    placement: options.policy.workspace.placement,
                    buildId: options.policy.workspace.buildId,
                    protocolVersion: options.policy.workspace.protocolVersion,
                  }
                  return yield* Effect.gen(function* () {
                    const binding =
                      options.ensureWorkspace === undefined
                        ? options.workspace.binding
                        : yield* operations.value.run(
                            {
                              kind: "rika.workspace.ensure",
                              payload: { sessionId: options.policy.sessionId, workspace: workspacePolicy },
                              replayPolicy: "provider-idempotent",
                              success: WorkspaceBinding,
                              failure: ContextMaterializationError,
                            },
                            options.ensureWorkspace(preparation),
                          )
                    if (
                      !sameBinding(options.policy.workspace, binding) &&
                      (!sameWorkspacePolicy(options.policy.workspace, binding) ||
                        binding.generation <= options.policy.workspace.generation)
                    )
                      return yield* rejected()
                    if (options.rebindWorkspace !== undefined)
                      yield* options.rebindWorkspace(binding).pipe(Effect.mapError(rejected))
                    if (!sameBinding(options.workspace.binding, binding)) return yield* rejected()
                    const retained = yield* Components.read(declaration)
                    let materialization = retained
                    if (materialization === null) {
                      materialization = yield* operations.value.run(
                        {
                          kind: "rika.session.materialize",
                          payload: {
                            sessionId: options.policy.sessionId,
                            policy: Pins.digest({ ...options.policy, workspace: workspacePolicy }),
                          },
                          replayPolicy: "provider-idempotent",
                          success: SessionMaterialization,
                          failure: ContextMaterializationError,
                        },
                        options.prepare(preparation),
                      )
                    } else if (!sameBinding(materialization.workspace, binding)) {
                      if (
                        !sameWorkspacePolicy(materialization.workspace, binding) ||
                        binding.generation <= materialization.workspace.generation
                      )
                        return yield* rejected()
                      yield* Components.command(declaration, {
                        id: `${hook.operationKey}:workspace`,
                        command: { _tag: "RebindWorkspace", expected: materialization.workspace, workspace: binding },
                      })
                      materialization = yield* Components.read(declaration)
                    }
                    if (materialization === null || !matchesPolicy(materialization, options.policy, binding))
                      return yield* rejected()
                    yield* composeSessionContext(options.agent, materialization)
                    if (retained === null)
                      yield* Components.command(declaration, {
                        id: `${hook.operationKey}:capture`,
                        command: { _tag: "Capture", materialization },
                      })
                    const context = yield* composeSessionContext({ ...options.agent, instructions: "" }, materialization)
                    const instructions = yield* Schema.decodeUnknownEffect(Schema.String)(context.agent.instructions)
                    return Hooks.AddContext([{ role: "system", content: instructions }])
                  }).pipe(
                    Effect.provideService(NestedOperation.Operations, operations.value),
                    Effect.provideService(ToolContext.ToolContext, {
                      signal,
                      emit: () => Effect.succeed(false),
                      sessionId: execution.message.sessionId,
                      runId: input.runId,
                      rootRunId: execution.rootRunId,
                      agentName: input.agentName,
                      operationKey: hook.operationKey,
                      admittedAt: execution.admittedAt,
                    }),
                  )
                }),
              ),
          }),
        ],
      })
    }),
  )
