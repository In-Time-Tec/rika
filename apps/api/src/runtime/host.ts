/* oxlint-disable effecttsgo/strict-effect-provide -- the actor incarnation owns this Host composition scope. */
/* oxlint-disable effecttsgo/any-unknown-in-error-context -- Host.make's requirements are closed by this composition. */
/* oxlint-disable typescript/no-unsafe-return -- Generalist's higher-kinded Host requirement is closed above. */
import { Context, Effect, Function, Layer, Schema, Stream, type Scope } from "effect"
import { LanguageModel, Toolkit } from "effect/unstable/ai"
import { Agent, Approvals, ModelRegistry, Permissions, ToolContext, ToolExecutor } from "generalist"
import { Host, type SessionHandle } from "generalist/host"
import type { Host as GeneralistHost } from "generalist/host"
import { RunStore, type Runtime } from "generalist/runtime"
import {
  WorkspaceComponent,
  nativeToolExecutionLayer,
  sameBinding,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { toolkit, tools } from "@rika/execution/tools"
import {
  ContextMaterializationError,
  composeSessionContext,
  effectiveAuthorization,
  makeSessionMaterializationComponent,
  deferredSessionMaterializationComponent,
  type SessionAuthorizationService,
  type SessionMaterialization,
} from "@rika/context"
import * as Components from "generalist/components"
import type { ThreadPartition } from "./partition"
import { preparationLayer, type EnsureSessionWorkspace, type PrepareSessionContext } from "./preparation"
import type { RuntimeWorkspace } from "./workspace"

export const rikaAgent = Agent.make({
  name: "rika",
  input: Schema.String,
  output: Schema.String,
  instructions:
    "Work in the assigned Rika workspace. Use native tools for bounded workspace operations. Inspect unknown outcomes before retrying mutating work.",
  toolkit,
  toolExecution: "background",
})

export interface ApiV2ContextComposition {
  readonly materialization: SessionMaterialization
  readonly prepare?: PrepareSessionContext
  readonly ensureWorkspace?: EnsureSessionWorkspace
  readonly rebindWorkspace?: RuntimeWorkspace["rebind"]
  readonly authorization: SessionAuthorizationService
  readonly modelRegistry: Layer.Layer<ModelRegistry.ModelRegistry>
}

export interface HostOptions {
  readonly revision: string
  readonly workspace: WorkspaceExecutorService
  readonly context: ApiV2ContextComposition
  readonly limits?: {
    readonly tree: { readonly maxDepth: number; readonly maxSessions: number }
    readonly concurrency: { readonly agents: number; readonly tools: number }
  }
}

export type RikaHost = GeneralistHost<{ readonly rika: Agent.Any }>

export const hostEffect = (
  options: HostOptions,
): Effect.Effect<RikaHost, never, Runtime.Runtime | RunStore.RunStore | Scope.Scope> => {
  const composition = options.context
  const authorizeTool = Effect.fn("Rika.Host.authorizeTool")(
    function* (input: { readonly runId: string | undefined; readonly sessionId: string; readonly name: string }) {
      if (input.runId === undefined) return false
      const store = yield* RunStore.RunStore
      const execution = yield* store.loadExecution(input.runId)
      if (execution.message.sessionId !== input.sessionId) return false
      const root = execution.rootRunId === input.runId ? execution : yield* store.loadExecution(execution.rootRunId)
      if (root.message.sessionId !== composition.materialization.sessionId) return false
      const authorization = yield* composition.authorization
        .current(composition.materialization.sessionId)
        .pipe(Effect.flatMap((current) => effectiveAuthorization(composition.materialization, current)))
      return authorization.canResume && authorization.allowedTools.includes(input.name)
    },
    Effect.orElseSucceed(() => false),
  )
  const contextDeclaration = makeSessionMaterializationComponent(composition.materialization)
  const native = nativeToolExecutionLayer(options.workspace).pipe(Layer.provide(ToolContext.layerDefault))
  const permissions = Layer.effect(
    Permissions.Permissions,
    Effect.gen(function* () {
      const store = yield* RunStore.RunStore
      return Permissions.Permissions.of({
        evaluate: (request) =>
          request.sessionId === undefined || request.runId === undefined
            ? Effect.succeed({ _tag: "Deny" as const, reason: "Native Tools require a hosted Run" })
            : authorizeTool({ sessionId: request.sessionId, runId: request.runId, name: request.call.name }).pipe(
                Effect.provideService(RunStore.RunStore, store),
                Effect.map(
                  (allowed): Permissions.Decision =>
                    allowed
                      ? { _tag: "Allow" }
                      : { _tag: "Deny", reason: "The Tool, model, or credentials are no longer authorized" },
                ),
              ),
      })
    }),
  )
  const modelAccess = (selection: ModelRegistry.ModelSelection) =>
    composition.authorization.current(composition.materialization.sessionId).pipe(
      Effect.flatMap((authorization) => effectiveAuthorization(composition.materialization, authorization)),
      Effect.flatMap((authorization) =>
        authorization.canResume
          ? Effect.void
          : Effect.fail(
              ModelRegistry.LanguageModelNotRegistered.make({ provider: selection.provider, model: selection.model }),
            ),
      ),
      Effect.catchTag("RikaContextMaterializationError", () =>
        Effect.fail(
          ModelRegistry.LanguageModelNotRegistered.make({ provider: selection.provider, model: selection.model }),
        ),
      ),
    )
  const models = Layer.effectContext(
    Effect.gen(function* () {
      const registry = yield* ModelRegistry.ModelRegistry
      const model = yield* registry.withModel(composition.materialization.model.selection, LanguageModel.LanguageModel)
      return Context.make(LanguageModel.LanguageModel, model).pipe(
        Context.add(
          ModelRegistry.ModelRegistry,
          ModelRegistry.ModelRegistry.of({
            ...registry,
            withModel: (selection, effect) =>
              modelAccess(selection).pipe(Effect.andThen(registry.withModel(selection, effect))),
            stream: (selection, stream) =>
              Stream.unwrap(modelAccess(selection).pipe(Effect.as(registry.stream(selection, stream)))),
          }),
        ),
      )
    }),
  ).pipe(Layer.provide(composition.modelRegistry))
  const guarded = Layer.effect(
    ToolExecutor.ToolExecutor,
    Effect.gen(function* () {
      const executor = yield* ToolExecutor.ToolExecutor
      const store = yield* RunStore.RunStore
      return ToolExecutor.ToolExecutor.of({
        ...executor,
        execute: (request) =>
          Effect.gen(function* () {
            const context = yield* ToolContext.ToolContext
            const allowed = yield* authorizeTool({
              sessionId: context.sessionId,
              runId: context.runId,
              name: request.call.name,
            }).pipe(Effect.provideService(RunStore.RunStore, store))
            if (!allowed) {
              const failure = {
                _tag: "ToolError",
                tool: request.call.name,
                message: "The native Tool is not currently authorized for this Session",
                kind: "operation",
                category: "access_denied",
                outcome: "known",
                recovery: "after_change",
                nextAction: "Restore the required Tool authorization before retrying",
              }
              return { _tag: "DomainFailure" as const, failure, encodedFailure: failure }
            }
            return yield* executor.execute(request)
          }),
      })
    }),
  ).pipe(Layer.provide(native))
  return Effect.gen(function* () {
    if (!sameBinding(composition.materialization.workspace, options.workspace.binding))
      return yield* ContextMaterializationError.make({
        reason: "binding",
        message: "Hosted context and Executor workspace bindings differ",
      })
    if (composition.prepare !== undefined && composition.materialization.guidance.payload.entries.length !== 0)
      return yield* ContextMaterializationError.make({
        reason: "guidance",
        message: "Deferred Session context must not contain preloaded workspace guidance",
      })
    const admittedTools = new Set(composition.materialization.tools.map((tool) => tool.name))
    const context = yield* composeSessionContext(
      { ...rikaAgent, toolkit: Toolkit.make(...tools.filter((tool) => admittedTools.has(tool.name))) },
      composition.materialization,
    )
    const services = yield* Layer.build(
      Layer.mergeAll(
        Components.layer([
          WorkspaceComponent.declaration.registration,
          composition.prepare === undefined
            ? contextDeclaration.registration
            : deferredSessionMaterializationComponent.registration,
        ]),
        permissions,
        Approvals.layerAutoApprove,
        native,
        guarded,
        toolkit.toLayer({
          bash: () => Effect.die("Bash bypassed the native ToolExecutor"),
          read: () => Effect.die("Read bypassed the native ToolExecutor"),
          edit: () => Effect.die("Edit bypassed the native ToolExecutor"),
          grep: () => Effect.die("Grep bypassed the native ToolExecutor"),
          web_search: () => Effect.die("Web Search bypassed the native ToolExecutor"),
        }),
        context.instructions,
        models,
        composition.prepare === undefined
          ? Layer.empty
          : preparationLayer({
              agent: rikaAgent,
              policy: composition.materialization,
              authorization: composition.authorization,
              prepare: composition.prepare,
              workspace: options.workspace,
              ensureWorkspace: composition.ensureWorkspace,
              rebindWorkspace: composition.rebindWorkspace,
            }).pipe(Layer.provide(native)),
      ),
    )
    return yield* Host.make({
      revision: options.revision,
      agents: { rika: context.agent },
      tools,
      limits: options.limits ?? {
        tree: { maxDepth: 3, maxSessions: 32 },
        concurrency: { agents: 4, tools: 8 },
      },
    }).pipe(Effect.provide(services))
  }).pipe(Effect.orDie)
}

/**
 * Create-or-read is intentionally the only product-to-Session bridge. It establishes no queue item and submits no
 * Run, so a PostgreSQL Thread row cannot accidentally start work. A same-id retry converges on the canonical Session.
 */
export class SessionConvergenceError extends Schema.TaggedError<SessionConvergenceError>()(
  "RikaApiV2SessionConvergenceError",
  { message: Schema.String },
) {}

const ensureRootSessionImpl = (
  host: RikaHost,
  partition: ThreadPartition,
): Effect.Effect<SessionHandle, SessionConvergenceError, never> =>
  host.sessions
    .create({ id: partition.rootSessionId, title: `Thread ${partition.threadId}`, agent: rikaAgent.name })
    .pipe(
      Effect.catch(() =>
        host.sessions
          .get(partition.rootSessionId)
          .pipe(
            Effect.mapError(() => SessionConvergenceError.make({ message: "Canonical Session could not be read" })),
          ),
      ),
    )

export const ensureRootSession: {
  (host: RikaHost): (partition: ThreadPartition) => ReturnType<typeof ensureRootSessionImpl>
  (host: RikaHost, partition: ThreadPartition): ReturnType<typeof ensureRootSessionImpl>
} = Function.dual(2, ensureRootSessionImpl)

export type RikaSession = SessionHandle

const sessionPartitionImpl = (session: SessionHandle, partition: ThreadPartition) =>
  session.id === partition.rootSessionId ? partition : undefined

export const sessionPartition: {
  (session: SessionHandle): (partition: ThreadPartition) => ReturnType<typeof sessionPartitionImpl>
  (session: SessionHandle, partition: ThreadPartition): ReturnType<typeof sessionPartitionImpl>
} = Function.dual(2, sessionPartitionImpl)
