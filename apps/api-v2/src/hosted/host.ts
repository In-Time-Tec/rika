/* oxlint-disable effecttsgo/strict-effect-provide -- the actor incarnation owns this Host composition scope. */
/* oxlint-disable effecttsgo/any-unknown-in-error-context -- Host.make's requirements are closed by this composition. */
/* oxlint-disable typescript/no-unsafe-return -- Generalist's higher-kinded Host requirement is closed above. */
import { Context, Effect, Function, Layer, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { Agent, Approvals, ModelRegistry, Permissions, ToolContext } from "generalist"
import { Host, ToolIdentity, type SessionHandle } from "generalist/host"
import type { Host as GeneralistHost } from "generalist/host"
import type { Runtime } from "generalist/runtime"
import { WorkspaceComponent } from "@rika/execution-v2"
import {
  makeSessionMaterializationComponent,
  type SessionAuthorizationService,
  type SessionContextComposition,
  type SessionMaterialization,
} from "@rika/context-v2"
import * as Components from "generalist/components"
import type { ThreadPartition, WorkspacePlacement } from "./partition"

export const RunnerResult = Schema.Struct({
  outcome: Schema.Literals(["completed", "unknown"]),
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
})
export type RunnerResult = typeof RunnerResult.Type

export class RunnerWorkspaceError extends Schema.TaggedError<RunnerWorkspaceError>()("RikaApiV2RunnerWorkspaceError", {
  kind: Schema.Literals(["unavailable", "forbidden", "unknown"]),
  message: Schema.String,
}) {}

export interface RunnerInvocation {
  readonly command: string
  readonly sessionId: string
  readonly runId?: string
  readonly target: WorkspacePlacement
}

export interface RunnerWorkspaceService {
  readonly placement: WorkspacePlacement
  readonly execute: (input: RunnerInvocation) => Effect.Effect<RunnerResult, RunnerWorkspaceError>
}

export class RunnerWorkspace extends Context.Service<RunnerWorkspace, RunnerWorkspaceService>()(
  "@rika/api-v2/hosted/host/RunnerWorkspace",
) {}

const runnerParameters = Schema.Struct({ command: Schema.String })

const runnerTool = Tool.make("rika_runner", {
  description: "Run one bounded command in the explicitly assigned Rika Runner or Orb workspace.",
  parameters: runnerParameters,
  success: RunnerResult,
  failure: Schema.Struct({ kind: Schema.String, message: Schema.String }),
  failureMode: "return",
  dependencies: [RunnerWorkspace, ToolContext.ToolContext],
}).annotate(ToolIdentity, {
  implementation: "rika/api-v2/runner-workspace",
  policy: "rika/api-v2/runner-workspace",
})

export const runnerToolkit = Toolkit.make(runnerTool)

const runnerHandler = Effect.fn("RikaApiV2.RunnerWorkspace.execute")(function* (input: typeof runnerParameters.Type) {
  const workspace = yield* RunnerWorkspace
  const context = yield* ToolContext.ToolContext
  const invocation = {
    command: input.command,
    sessionId: context.sessionId,
    target: workspace.placement,
  }
  if (context.runId !== undefined) Object.assign(invocation, { runId: context.runId })
  return yield* workspace.execute(invocation)
})

const makeAuthorizedRunnerHandler = (authorization: SessionAuthorizationService) =>
  Effect.fn("RikaApiV2.RunnerWorkspace.authorizedExecute")(function* (input: typeof runnerParameters.Type) {
    const context = yield* ToolContext.ToolContext
    const current = yield* authorization
      .current(context.sessionId)
      .pipe(Effect.mapError((error) => RunnerWorkspaceError.make({ kind: "forbidden", message: error.message })))
    if (!current.allowedTools.includes("rika_runner"))
      return yield* RunnerWorkspaceError.make({ kind: "forbidden", message: "rika_runner is not currently allowed" })
    return yield* runnerHandler(input)
  })

export const rikaAgent = Agent.make({
  name: "rika",
  input: Schema.String,
  output: Schema.String,
  instructions:
    "Work in the assigned Rika workspace. Use rika_runner for bounded commands and report unknown outcomes without retrying them blindly.",
  toolkit: runnerToolkit,
  toolExecution: "background",
})

export interface ApiV2ContextComposition {
  readonly context: SessionContextComposition
  readonly materialization: SessionMaterialization
  readonly authorization: SessionAuthorizationService
  readonly modelRegistry: Layer.Layer<ModelRegistry.ModelRegistry>
}

export interface HostOptions {
  readonly revision: string
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  readonly workspace: RunnerWorkspaceService
  /** Restored context-v2 Session composition; static agent defaults are only for legacy callers. */
  readonly context?: SessionContextComposition
  /** Provider registry selected by context-v2 model configuration. */
  readonly contextModelRegistry?: Layer.Layer<ModelRegistry.ModelRegistry>
  /** Canonical context-v2 materialization restored into the Session component registry. */
  readonly contextMaterialization?: SessionMaterialization
  /** Current product authorization for context-v2 tool admission. */
  readonly contextAuthorization?: SessionAuthorizationService
  readonly limits?: {
    readonly tree: { readonly maxDepth: number; readonly maxSessions: number }
    readonly concurrency: { readonly agents: number; readonly tools: number }
  }
}

const agents = { rika: rikaAgent } as const
export type RikaHost = GeneralistHost<typeof agents>

export const hostEffect = (options: HostOptions): Effect.Effect<RikaHost, never, Runtime.Runtime> => {
  const activeAgent = options.context?.agent ?? rikaAgent
  const legacyHandler =
    options.contextAuthorization === undefined
      ? runnerHandler
      : makeAuthorizedRunnerHandler(options.contextAuthorization)
  const contextDeclaration =
    options.contextMaterialization === undefined
      ? undefined
      : makeSessionMaterializationComponent(options.contextMaterialization)
  const hostOptions = {
    revision: options.revision,
    agents: { rika: activeAgent },
    tools: [runnerTool] as const,
    limits: options.limits ?? {
      tree: { maxDepth: 3, maxSessions: 32 },
      concurrency: { agents: 4, tools: 8 },
    },
  }
  return Host.make(hostOptions).pipe(
    Effect.provide(
      Layer.mergeAll(
        options.model,
        Layer.succeed(RunnerWorkspace, options.workspace),
        Components.layer(
          contextDeclaration === undefined
            ? [WorkspaceComponent.declaration.registration]
            : [WorkspaceComponent.declaration.registration, contextDeclaration.registration],
        ),
        Permissions.layerRuleset({ rules: [{ pattern: "rika_runner", level: "allow" }], fallback: "deny" }),
        Approvals.layerAutoApprove,
        runnerToolkit
          .toLayer({ rika_runner: legacyHandler })
          .pipe(Layer.provide(Layer.succeed(RunnerWorkspace, options.workspace))),
        ...(options.context?.instructions === undefined ? [] : [options.context.instructions]),
        ...(options.contextModelRegistry === undefined ? [] : [options.contextModelRegistry]),
      ),
    ),
    Effect.orDie,
  )
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
