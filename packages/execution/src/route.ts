import {
  Agent,
  AgentManifest,
  Compaction,
  ExecutableManifest,
  LanguageModel,
  ModelRegistry,
  Pins,
  ToolContext,
  ToolExecutor,
} from "tenetkit"
import { ModelRoute } from "tenetkit/ai"
import { Errors, ExecutableRegistration, ExecutableResolver } from "tenetkit/runtime"
import type { HarnessState } from "tenetkit/harness"
import { Cell, CellTool, KernelPool, type KernelProfile } from "tenetkit/repl"
import * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import * as BindingModules from "@rika/kernel/binding-modules"
import * as HarnessPromptSections from "@rika/kernel/harness-prompt-sections"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import type { ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import { Clock, Context, DateTime, Effect, Function, Layer, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { profileInstructions } from "./agent-instructions"
import * as Models from "./models"
import * as Registration from "./registration"
import * as RemoteCells from "./remote-cells"

type ModelSnapshot = ExecutionRoute.ExecutionRouteModelSnapshot
type RouteSnapshot = ExecutionRoute.ExecutionRouteSnapshot

export interface KernelOptions {
  readonly runtimeVersion: string
  readonly dataRoot: string
  readonly limits?: KernelProfile.Limits
  readonly trustMode?: KernelProfile.TrustMode
}

export type LocalCellServices = KernelPool.KernelPool | ExecutorRuntime.CellContext

export interface LocalCellRoute {
  readonly _tag: "Local"
  readonly services: Context.Context<LocalCellServices>
}

export interface RemoteCellRoute {
  readonly _tag: "Remote"
  readonly cells: Layer.Layer<RemoteCells.Service>
  readonly admit: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly workspaceId: string
  }) => Effect.Effect<void, RemoteCells.AdmissionFailure>
}

export type CellRoute = LocalCellRoute | RemoteCellRoute

export interface LocalCellResolver {
  readonly _tag: "Local"
  readonly forWorkspace: (workspace: string) => Effect.Effect<Context.Context<LocalCellServices>>
}

export type CellResolver = LocalCellResolver | RemoteCellRoute

export const resolveCellRoute: {
  (workspace: string): (resolver: CellResolver) => Effect.Effect<CellRoute>
  (resolver: CellResolver, workspace: string): Effect.Effect<CellRoute>
} = Function.dual(
  2,
  (resolver: CellResolver, workspace: string): Effect.Effect<CellRoute> =>
    resolver._tag === "Remote"
      ? Effect.succeed(resolver)
      : resolver.forWorkspace(workspace).pipe(Effect.map((services) => ({ _tag: "Local" as const, services }))),
)

export interface ConfigureOptions {
  readonly executionRoute: RouteSnapshot
  readonly workspace: string
  readonly executionIdentity?: {
    readonly threadId: string
    readonly turnId: string
  }
  readonly kernel: KernelOptions
  readonly cell?: CellRoute
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreShape
  readonly openAiAccountAccess?: (credentialIdentity: string) => OpenAiAuth.CredentialAccess
}

export interface ConfiguredExecutable {
  readonly executable: ExecutableManifest.PinnedExecutable
  readonly titleExecutable: ExecutableManifest.PinnedExecutable
  readonly registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly titleRegistrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly resolverEntries: ReadonlyArray<ExecutableResolver.StaticAgentExecutable>
  readonly profiles: Readonly<Record<string, AgentManifest.PinnedAgent>>
  readonly kernelProfile: KernelProfile.KernelProfile
}

export interface ResolverOptions {
  readonly kernel: KernelOptions
  readonly cell?: CellResolver
  readonly capabilities?: (workspace: string) => Effect.Effect<{
    readonly skills: ReadonlyArray<ExecutionPins.SkillPin>
    readonly harnessSnapshot: HarnessState.HarnessState
  }>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreShape
  readonly openAiAccountAccess?: (credentialIdentity: string) => OpenAiAuth.CredentialAccess
}

type ResolvedAgent = ExecutableResolver.StaticAgentExecutable["agent"]

/**
 * Rika caps execution only by subagent depth and count, both carried by the tree policy. Every
 * other dimension stays unlimited, so a long thread is never terminated by a run budget. A
 * BudgetLimits with no dimension set is the exact way to express that: `remaining === undefined`
 * short-circuits each charge. This is stated explicitly rather than by omitting the option, because
 * an omitted budget is an absent opinion that a host is free to fill with a default ceiling.
 */
const unlimitedBudget = {} as const satisfies AgentManifest.AgentManifest["budget"]

/**
 * The exact values the Session's kernel is built from. The admitted profile pin is derived from
 * these and from nothing else, so a pin can never describe a kernel the host did not run.
 */
export { profileInstructions }

/**
 * An agent that runs cells is told what its cell can reach. The Title agent carries no tool, so it
 * keeps the one sentence it was given rather than a description of a surface it cannot use.
 */
/**
 * What one Execution's harness adds to the prompt every agent in it reads. An absent harness adds
 * nothing rather than an empty section, so a session with no refinements looks exactly as it did.
 */
const harnessSupplement = (
  harness: HarnessState.HarnessState | undefined,
  skills: ReadonlyArray<ExecutionPins.SkillPin>,
): string =>
  harness === undefined
    ? ""
    : HarnessPromptSections.block({
        harness,
        skillListings: skills.map((skill) => `- ${skill.name}`).join("\n"),
        mcpServers: [],
      })

export const agentInstructionsWith: {
  (own: string): (surface: string) => string
  (surface: string, own: string): string
} = Function.dual(2, (surface: string, own: string): string =>
  own === profileInstructions.title ? own : [own, "", surface].join("\n"),
)

const applicationPin = (
  route: RouteSnapshot,
  workspace: string,
  executionIdentity: ConfigureOptions["executionIdentity"],
) =>
  Pins.makeCapability({
    ...Registration.codecs.applicationContext.identity,
    route,
    workspace,
    ...(executionIdentity === undefined ? {} : { executionIdentity }),
  })

const modelRegistryPin = (route: ModelSnapshot) =>
  Pins.makeCapability({
    ...Registration.codecs.modelRegistryRoute.identity,
    registrationIdentity: route.registrationIdentity,
  })

const modelPin = (route: ModelSnapshot) => Pins.makeModel({ ...Registration.codecs.modelRoute.identity, route })

const compactionPin = (route: RouteSnapshot) =>
  Pins.makeCapability({
    ...Registration.codecs.compaction.identity,
    intent: route.compaction,
    limits: route.main.compaction,
    summaryModel: route.compactionSummary.registrationIdentity,
  })

const toolPins = (toolkit: Toolkit.Any) =>
  Object.values(toolkit.tools).map((tool) => ({
    name: tool.name,
    pin: Registration.toolPin(tool),
  }))

const agentEntry = (pinned: AgentManifest.PinnedAgent) => ({
  _tag: "Agent" as const,
  pin: pinned.pin,
  manifest: pinned.manifest,
})

const registrationsFrom = <E>(layer: Layer.Layer<ModelRegistry.ModelRegistry, E>) =>
  Effect.scoped(
    Layer.build(layer).pipe(
      Effect.flatMap((context) =>
        ModelRegistry.registrations().pipe(
          Effect.provideService(ModelRegistry.ModelRegistry, Context.get(context, ModelRegistry.ModelRegistry)),
        ),
      ),
    ),
  )

const routedModel = (
  route: ModelSnapshot,
  override: Layer.Layer<ModelRegistry.ModelRegistry> | undefined,
  credentialStore: ConfigureOptions["credentialStore"],
  openAiAccountAccess: ConfigureOptions["openAiAccountAccess"],
) =>
  Effect.gen(function* () {
    const available =
      override === undefined
        ? yield* Effect.forEach(route.candidates, (candidate) =>
            registrationsFrom(
              Models.layer({
                candidate,
                ...(credentialStore === undefined ? {} : { credentialStore }),
                ...(openAiAccountAccess === undefined ? {} : { openAiAccountAccess }),
              }),
            ).pipe(Effect.mapError((cause) => Errors.ExecutableRegistrationInvalid.make({ message: String(cause) }))),
          ).pipe(Effect.map((groups) => groups.flat()))
        : yield* registrationsFrom(override)
    const candidates = route.candidates.map((candidate) => {
      const exact = available.find(
        (entry) =>
          entry.provider === candidate.providerConnection.provider &&
          entry.model === candidate.model &&
          entry.registrationKey === candidate.registrationIdentity,
      )
      const registration =
        exact ??
        (override === undefined
          ? undefined
          : available.find(
              (entry) => entry.provider === candidate.providerConnection.provider && entry.model === candidate.model,
            ))
      if (registration === undefined)
        throw new Error(`Missing model candidate registration ${candidate.registrationIdentity}`)
      return registration.registrationKey === candidate.registrationIdentity
        ? registration
        : { ...registration, registrationKey: candidate.registrationIdentity }
    }) as [ModelRegistry.Registration, ...Array<ModelRegistry.Registration>]
    const routed = yield* ModelRoute.make({ candidates })
    return { ...routed, layer: ModelRegistry.layer([Effect.succeed(routed.registration)]) }
  })

type RoutedModel = ModelRoute.Route & { readonly layer: Layer.Layer<ModelRegistry.ModelRegistry> }

interface AgentDefinition {
  readonly agent: ResolvedAgent
  readonly pinned: AgentManifest.PinnedAgent
}

type AgentEnvironment = Layer.Layer<ModelRegistry.ModelRegistry>

const agentDefinition = (
  route: ModelSnapshot,
  routed: RoutedModel,
  name: string,
  agentInstructions: string,
  supplementalInstructions: string | undefined,
  tools: ReadonlyArray<Tool.Any>,
  environment: AgentEnvironment,
  children: AgentManifest.AgentManifest["children"],
  applicationContextPin: ReturnType<typeof applicationPin>,
  compaction: AgentManifest.CompactionIdentity | undefined,
  kernelProfilePin: Pins.CapabilityPin | undefined,
  capabilities: {
    readonly skills: ReadonlyArray<AgentManifest.NamedCapability>
    readonly services: ReadonlyArray<AgentManifest.NamedCapability>
  },
): AgentDefinition => {
  const agent = Agent.withTools(
    Agent.make({
      name: `rika-${name.toLowerCase()}`,
      instructions: agentInstructions,
      ...(supplementalInstructions === undefined ? {} : { supplemental: supplementalInstructions }),
      model: routed.selection,
      toolScheduling: tools.length === 0 ? { maxConcurrency: 1, parallelSafe: [] } : CellTool.scheduling,
      metadata: { productProfile: name },
      budget: unlimitedBudget,
    }),
    tools,
  )
  const pinned = AgentManifest.fromLiveAgent(agent, {
    model: modelPin(route),
    tools: toolPins(agent.toolkit),
    skills: capabilities.skills,
    services: [
      { name: "model-registry", pin: modelRegistryPin(route) },
      { name: "rika-application-context", pin: applicationContextPin },
      ...(compaction === undefined ? [] : [{ name: "compaction", pin: compaction.service }]),
      ...(kernelProfilePin === undefined ? [] : [{ name: "rika-kernel-profile", pin: kernelProfilePin }]),
      ...capabilities.services,
    ],
    policy: { _tag: "Portable", policy: agent.policy.snapshot! },
    budget: unlimitedBudget,
    children,
    ...(compaction === undefined ? {} : { compaction }),
  })
  return { agent: Agent.close(agent, environment), pinned }
}

const rootChildNames = ["Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const
type ChildProfileName = (typeof rootChildNames)[number]

const unsupportedCellTool = (tool: string) =>
  ToolExecutor.FrameworkFailure.make({
    stage: "handler",
    tool,
    message: `the configured cell adapter does not route ${tool}`,
  })

const unavailableCellExecutor = Layer.succeed(
  ToolExecutor.ToolExecutor,
  ToolExecutor.ToolExecutor.of({ execute: (request) => unsupportedCellTool(request.call.name) }),
)

const deadlineFailure = (failure: Cell.CellFailure, deadlineMillis: number): Cell.CellFailure => {
  if (failure._tag !== "tenetkit/repl/CellExecutionFailed") return failure
  const exceeded =
    failure.name === "Celltimed-out" || (failure.name === "Cellaborted" && failure.durationMillis >= deadlineMillis)
  if (!exceeded) return failure
  return Cell.CellExecutionFailed.make({
    ...failure,
    name: "CellDeadlineExceeded",
    message: `cell exceeded the ${deadlineMillis / 1_000}s deadline; split long work across cells or start it with rika.processes.start`,
  })
}

const deadlinePool = (pool: KernelPool.Interface, deadlineMillis: number): KernelPool.Interface => ({
  ...pool,
  execute: (request) =>
    pool.execute(request).pipe(
      Effect.mapError((failure) => deadlineFailure(failure, deadlineMillis)),
      Effect.map((execution) => ({
        events: execution.events.pipe(Stream.mapError((failure) => deadlineFailure(failure, deadlineMillis))),
        result: execution.result.pipe(Effect.mapError((failure) => deadlineFailure(failure, deadlineMillis))),
      })),
    ),
})

/**
 * The pool arrives already built, owned by the composition root's own scope, because it outlives
 * every cell that uses it. Building it here instead would give it whichever cell forced it first,
 * and that cell's scope closes when it finishes — leaving every later cell holding a released map
 * that answers `RcMap.get` with an interrupt rather than a worker.
 *
 * Only `enter` is scoped per call: it registers this cell's identity for the duration of this cell
 * and must be removed when it ends.
 */
const cellExecutor = (
  services: Context.Context<LocalCellServices>,
  deadlineMillis: number,
): Layer.Layer<ToolExecutor.ToolExecutor> =>
  Layer.succeed(
    ToolExecutor.ToolExecutor,
    ToolExecutor.ToolExecutor.of({
      execute: (request) => {
        if (!CellTool.route.matches(request)) return unsupportedCellTool(request.call.name)
        return Effect.scoped(
          Context.get(services, ExecutorRuntime.CellContext)
            .enter(request.sessionId)
            .pipe(
              Effect.andThen(
                CellTool.route
                  .execute(request)
                  .pipe(
                    Effect.provideService(
                      KernelPool.KernelPool,
                      KernelPool.KernelPool.of(
                        deadlinePool(Context.get(services, KernelPool.KernelPool), deadlineMillis),
                      ),
                    ),
                  ),
              ),
            ),
        )
      },
    }),
  )

const remoteCellExecutor = (
  route: RemoteCellRoute,
  workspace: string,
  executionIdentity: ConfigureOptions["executionIdentity"],
  deadlineMillis: number,
): Layer.Layer<ToolExecutor.ToolExecutor> =>
  Layer.effect(
    ToolExecutor.ToolExecutor,
    Effect.map(RemoteCells.Service, (cells) =>
      ToolExecutor.ToolExecutor.of({
        execute: (request) => {
          if (!CellTool.route.matches(request)) return unsupportedCellTool(request.call.name)
          return Effect.gen(function* () {
            const context = yield* ToolContext.ToolContext
            const authority = yield* ExecutorRuntime.capture
            const admittedAtMillis = yield* Clock.currentTimeMillis
            const cellDeadlineAt = DateTime.formatIso(DateTime.makeUnsafe(admittedAtMillis + deadlineMillis))
            const deadlineAt =
              context.deadline === undefined || cellDeadlineAt < context.deadline ? cellDeadlineAt : context.deadline
            const operationKey = context.operationKey
            if (operationKey === undefined || operationKey.length === 0)
              return yield* ToolExecutor.FrameworkFailure.make({
                stage: "placement",
                tool: request.call.name,
                message: "remote cell execution requires an operation key",
              })
            if (executionIdentity === undefined || context.runId === undefined || context.rootRunId === undefined)
              return yield* ToolExecutor.FrameworkFailure.make({
                stage: "placement",
                tool: request.call.name,
                message: "remote cell execution requires thread, turn, and run identities",
              })
            const identity = executionIdentity
            const runId = context.runId
            const rootRunId = context.rootRunId
            const remote = ToolExecutor.remote({
              toolkit: CellTool.toolkit,
              tools: [CellTool.name],
              execute: (placement) =>
                Effect.gen(function* () {
                  const parameters = yield* Schema.decodeUnknownEffect(CellTool.Parameters)(placement.call.params).pipe(
                    Effect.mapError((cause) =>
                      ToolExecutor.FrameworkFailure.make({
                        stage: "decode-input",
                        tool: placement.call.name,
                        message: String(cause),
                      }),
                    ),
                  )
                  const response = yield* cells.execute(
                    RemoteCells.Request.make({
                      operationKey,
                      workspaceId: workspace,
                      sessionId: placement.sessionId,
                      threadId: identity.threadId,
                      turnId: identity.turnId,
                      runId,
                      rootRunId,
                      toolCallId: context.toolCallId ?? placement.call.id,
                      code: parameters.code,
                      attempt: context.attempt ?? 0,
                      replayPolicy: "never",
                      admittedAt: DateTime.formatIso(DateTime.makeUnsafe(admittedAtMillis)),
                      deadlineAt,
                    }),
                    authority,
                  )
                  return yield* Schema.decodeUnknownEffect(RemoteCells.Response, {
                    onExcessProperty: "error",
                  })(response).pipe(
                    Effect.mapError((cause) =>
                      ToolExecutor.FrameworkFailure.make({
                        stage: "placement",
                        tool: placement.call.name,
                        message: `remote cell response is invalid: ${String(cause)}`,
                      }),
                    ),
                  )
                }),
            })
            return yield* remote.execute(request)
          })
        },
      }),
    ),
  ).pipe(Layer.provide(route.cells))

export const configure = (
  options: ConfigureOptions,
): Effect.Effect<
  ConfiguredExecutable,
  ModelRoute.AvailabilitySemanticsMissing | Errors.ExecutableRegistrationInvalid
> =>
  Effect.gen(function* () {
    const route = options.executionRoute
    const contextPin = applicationPin(route, options.workspace, options.executionIdentity)
    const routes = {
      Root: route.main,
      Title: route.title,
      Compaction: route.compactionSummary,
      Oracle: route.oracle,
      Librarian: route.agents.librarian,
      Painter: route.agents.painter,
      ReadThread: route.agents.readThread,
      Review: route.agents.review,
      Surgeon: route.agents.surgeon,
      Task: route.agents.task,
    } as const
    const routed = Object.fromEntries(
      yield* Effect.forEach(Object.entries(routes), ([name, model]) =>
        routedModel(model, options.modelServices, options.credentialStore, options.openAiAccountAccess).pipe(
          Effect.map((value) => [name, value] as const),
        ),
      ),
    ) as Record<keyof typeof routes, RoutedModel>
    const compactionIdentity: AgentManifest.CompactionIdentity = {
      service: compactionPin(route),
      summaryModel: modelPin(route.compactionSummary),
      contextWindow: route.main.compaction.contextWindow,
      reserveTokens: route.main.compaction.reserveTokens,
      keepRecentTokens: route.main.compaction.keepRecentTokens,
      strategyIdentity: route.compaction.strategy,
      summaryPromptIdentity: Pins.digest(route.compaction.summaryPrompt),
    }
    const summaryModel = Layer.unwrap(
      ModelRegistry.operate(
        routed.Compaction.selection,
        Effect.context<LanguageModel.LanguageModel>().pipe(Effect.map(Layer.succeedContext)),
      ),
    ).pipe(Layer.provide(routed.Compaction.layer))
    const compactionLayer = Compaction.layer({
      contextWindow: route.main.compaction.contextWindow,
      reserveTokens: route.main.compaction.reserveTokens,
      keepRecentTokens: route.main.compaction.keepRecentTokens,
      summaryPrompt: route.compaction.summaryPrompt,
      summaryModel: Layer.orDie(summaryModel),
    })
    const kernelProfile = KernelProfileRegistration.make({
      runtimeVersion: options.kernel.runtimeVersion,
      workspace: options.workspace,
      dataRoot: options.kernel.dataRoot,
      ...(options.kernel.limits === undefined ? {} : { limits: options.kernel.limits }),
      ...(options.kernel.trustMode === undefined ? {} : { trustMode: options.kernel.trustMode }),
    })
    const kernelProfilePin = yield* Schema.decodeUnknownEffect(Pins.CapabilityPin)(
      KernelProfileRegistration.pin(kernelProfile),
    ).pipe(Effect.mapError((cause) => Errors.ExecutableRegistrationInvalid.make({ message: String(cause) })))
    const skillPins = ExecutionPins.skills(options.skills ?? [])
    const harnessPins =
      options.harnessSnapshot === undefined
        ? { capabilities: [], registrations: [] }
        : ExecutionPins.harness(options.harnessSnapshot)
    const pinnedCapabilities = { skills: skillPins.capabilities, services: harnessPins.capabilities }
    let cellLayer = unavailableCellExecutor
    if (options.cell?._tag === "Local")
      cellLayer = cellExecutor(
        options.cell.services,
        options.kernel.limits?.cellDeadlineMillis ?? KernelProfileRegistration.defaultLimits.cellDeadlineMillis,
      )
    if (options.cell?._tag === "Remote")
      cellLayer = remoteCellExecutor(
        options.cell,
        options.workspace,
        options.executionIdentity,
        options.kernel.limits?.cellDeadlineMillis ?? KernelProfileRegistration.defaultLimits.cellDeadlineMillis,
      )
    const environment = (name: keyof typeof routes): AgentEnvironment => {
      const model = routed[name].layer
      if (name === "Title" || name === "Compaction") return Layer.orDie(model)
      return Layer.orDie(Layer.mergeAll(model, compactionLayer, cellLayer))
    }
    const supplemental = harnessSupplement(options.harnessSnapshot, options.skills ?? [])
    const mountedModules =
      options.cell === undefined
        ? []
        : BindingModules.make({
            workspace: options.workspace,
            workspaceDigest: "",
            trustMode: options.kernel.trustMode ?? "trusted-local",
            servers: [],
          })
    const limits = options.kernel.limits ?? KernelProfileRegistration.defaultLimits
    const cellSurface = BindingModules.cellInstructions({
      modules: mountedModules,
      workspace: options.workspace,
      channelBytes: limits.channelBytes,
      cellDeadlineMillis: limits.cellDeadlineMillis,
    })
    const withSurface = (own: string) => agentInstructionsWith(cellSurface, own)
    const roleInstructions = {
      Oracle: profileInstructions.Oracle,
      Librarian: profileInstructions.Librarian,
      Painter: profileInstructions.Painter,
      ReadThread: profileInstructions.ReadThread,
      Review: profileInstructions.Review,
      Surgeon: profileInstructions.Surgeon,
      Task: profileInstructions.Task,
    } as const
    const childSelections = rootChildNames.map((selection) => ({ selection }))
    const childDefinitionFor = (name: ChildProfileName): AgentDefinition =>
      agentDefinition(
        routes[name],
        routed[name],
        name,
        withSurface(roleInstructions[name]),
        supplemental === "" ? undefined : supplemental,
        [CellTool.tool],
        environment(name),
        childSelections,
        contextPin,
        compactionIdentity,
        kernelProfilePin,
        pinnedCapabilities,
      )
    const title = agentDefinition(
      routes.Title,
      routed.Title,
      "Title",
      profileInstructions.title,
      undefined,
      [],
      environment("Title"),
      [],
      contextPin,
      undefined,
      undefined,
      { skills: [], services: [] },
    )
    const childDefinitions = Object.fromEntries(
      rootChildNames.map((name) => [name, childDefinitionFor(name)]),
    ) as unknown as Readonly<Record<ChildProfileName, AgentDefinition>>
    const root = agentDefinition(
      route.main,
      routed.Root,
      "Root",
      withSurface(profileInstructions.root),
      supplemental === "" ? undefined : supplemental,
      [CellTool.tool],
      environment("Root"),
      childSelections,
      contextPin,
      compactionIdentity,
      kernelProfilePin,
      pinnedCapabilities,
    )
    const children = rootChildNames.map((name) => childDefinitions[name])
    const entries = [agentEntry(root.pinned), ...children.map((child) => agentEntry(child.pinned))]
    const profiles = rootChildNames.map((selection) => ({ selection, agent: childDefinitions[selection].pinned.pin }))
    const executable = ExecutableManifest.make({ root: root.pinned.pin, profiles, entries })
    const titleExecutable = ExecutableManifest.make({
      root: title.pinned.pin,
      entries: [agentEntry(title.pinned)],
    })
    const registrationMap = new Map<string, ExecutableRegistration.ExecutableRegistration>()
    for (const model of [
      routes.Root,
      routes.Title,
      routes.Oracle,
      routes.Librarian,
      routes.Painter,
      routes.ReadThread,
      routes.Review,
      routes.Surgeon,
      routes.Task,
    ]) {
      const { role: _role, ...registryPayload } = model
      registrationMap.set(modelPin(model), Registration.make(Registration.codecs.modelRoute, modelPin(model), model))
      registrationMap.set(
        modelRegistryPin(model),
        Registration.make(Registration.codecs.modelRegistryRoute, modelRegistryPin(model), registryPayload),
      )
    }
    registrationMap.set(
      modelPin(routes.Compaction),
      Registration.make(Registration.codecs.modelRoute, modelPin(routes.Compaction), routes.Compaction),
    )
    registrationMap.set(
      compactionPin(route),
      Registration.make(Registration.codecs.compaction, compactionPin(route), {
        keepRecentTokens: route.main.compaction.keepRecentTokens,
        strategyIdentity: route.compaction.strategy,
        summaryPromptIdentity: Pins.digest(route.compaction.summaryPrompt),
      }),
    )
    registrationMap.set(
      contextPin,
      Registration.make(Registration.codecs.applicationContext, contextPin, {
        workspace: options.workspace,
        ...(options.executionIdentity === undefined ? {} : { executionIdentity: options.executionIdentity }),
        executionRoute: route,
      }),
    )
    registrationMap.set(
      kernelProfilePin,
      Registration.make(Registration.codecs.kernelProfile, kernelProfilePin, kernelProfile),
    )
    for (const registration of [...skillPins.registrations, ...harnessPins.registrations]) {
      registrationMap.set(registration.pin, registration)
    }
    const registeredTools = [CellTool.tool]
    for (const tool of registeredTools) {
      registrationMap.set(
        Registration.toolPin(tool),
        Registration.make(Registration.codecs.tool, Registration.toolPin(tool), Registration.toolPayload(tool)),
      )
    }
    const registrations = yield* Effect.forEach(ExecutableRegistration.requiredPins(executable), (pin) => {
      const registration = registrationMap.get(pin)
      return registration === undefined
        ? Errors.ExecutableRegistrationInvalid.make({ message: `unregistered executable pin: ${pin}` })
        : Effect.succeed(registration)
    })
    const titleRegistrations = yield* Effect.forEach(ExecutableRegistration.requiredPins(titleExecutable), (pin) => {
      const registration = registrationMap.get(pin)
      return registration === undefined
        ? Errors.ExecutableRegistrationInvalid.make({ message: `unregistered title executable pin: ${pin}` })
        : Effect.succeed(registration)
    })
    return {
      kernelProfile,
      executable,
      titleExecutable,
      registrations,
      titleRegistrations,
      resolverEntries: [
        {
          executable,
          agent: root.agent,
          runOptions: {
            compaction: {
              contextWindow: route.main.compaction.contextWindow,
              reserveTokens: route.main.compaction.reserveTokens,
            },
          },
        },
        {
          executable: titleExecutable,
          agent: title.agent,
        },
        ...children.map((definition) => {
          const resolved = {
            executable: ExecutableManifest.make({
              root: root.pinned.pin,
              active: definition.pinned.pin,
              profiles,
              entries,
            }),
            agent: definition.agent,
          }
          return Object.assign(resolved, {
            runOptions: {
              compaction: {
                contextWindow: route.main.compaction.contextWindow,
                reserveTokens: route.main.compaction.reserveTokens,
              },
            },
          })
        }),
      ],
      profiles: {
        Title: title.pinned,
        ...Object.fromEntries(Object.entries(childDefinitions).map(([name, child]) => [name, child.pinned])),
      },
    }
  })

const invalid = (cause: unknown) => Errors.ExecutableRegistrationInvalid.make({ message: String(cause) })

export const makeResolver = (options: ResolverOptions): ExecutableResolver.Interface =>
  ExecutableResolver.ExecutableResolver.of({
    resolve: (input) =>
      Effect.gen(function* () {
        const active = input.manifest.entries.find((entry) => entry.pin === input.ref.active)
        if (active === undefined) return yield* Errors.ExecutablePinMissing.make({ runId: input.runId, ref: input.ref })
        const context = yield* Registration.read(Registration.codecs.applicationContext, input.registrations)
        const cell = options.cell === undefined ? undefined : yield* resolveCellRoute(options.cell, context.workspace)
        const capabilities =
          options.capabilities === undefined ? undefined : yield* options.capabilities(context.workspace)
        const configured = yield* configure({
          executionRoute: context.executionRoute,
          workspace: context.workspace,
          ...(context.executionIdentity === undefined ? {} : { executionIdentity: context.executionIdentity }),
          kernel: options.kernel,
          ...(cell === undefined ? {} : { cell }),
          ...(capabilities === undefined
            ? {}
            : { skills: capabilities.skills, harnessSnapshot: capabilities.harnessSnapshot }),
          ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
          ...(options.openAiAccountAccess === undefined ? {} : { openAiAccountAccess: options.openAiAccountAccess }),
          ...(options.modelServices === undefined ? {} : { modelServices: options.modelServices }),
        }).pipe(Effect.mapError(invalid))
        yield* Registration.verify({
          expected: [...configured.registrations, ...configured.titleRegistrations],
          actual: input.registrations,
          required: ExecutableRegistration.requiredPinsForActiveExecutable({
            ref: input.ref,
            manifest: input.manifest,
          }),
        })
        return yield* ExecutableResolver.makeStatic(configured.resolverEntries).resolve(input)
      }),
  })
