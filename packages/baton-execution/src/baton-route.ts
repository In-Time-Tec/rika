import {
  Agent,
  AgentManifest,
  Compaction,
  ExecutableManifest,
  LanguageModel,
  ModelRegistry,
  Pins,
  ToolExecutor,
  TurnPolicy,
} from "@batonfx/core"
import { AmazonBedrock, Anthropic, Deterministic, ModelRoute, OpenAi, OpenRouter } from "@batonfx/providers"
import { Errors, ExecutableRegistration, ExecutableResolver, Runtime } from "@batonfx/runtime"
import type { HarnessState } from "@batonfx/harness"
import { CellTool, KernelPool, type KernelProfile } from "@batonfx/repl"
import * as CellCallContext from "./baton-cell-call-context"
import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"
import * as BindingModules from "@rika/kernel/binding-modules"
import * as HarnessPromptSections from "@rika/kernel/harness-prompt-sections"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import type { ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import { Config, Context, Effect, Function, Layer, Option, Redacted, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { providerHttpClientLayer } from "./baton-provider-http"
import * as Registration from "./baton-registration"

type CandidateSnapshot = ExecutionRoute.ExecutionRouteModelCandidateSnapshot
type ModelSnapshot = ExecutionRoute.ExecutionRouteModelSnapshot
type RouteSnapshot = ExecutionRoute.ExecutionRouteSnapshot

export type AgentToolHandlers =
  | Tool.HandlersFor<typeof RoleToolkits.root.tools>
  | Tool.HandlersFor<typeof RoleToolkits.oracle.tools>
  | Tool.HandlersFor<typeof RoleToolkits.librarian.tools>
  | Tool.HandlersFor<typeof RoleToolkits.painter.tools>
  | Tool.HandlersFor<typeof RoleToolkits.readThread.tools>
  | Tool.HandlersFor<typeof RoleToolkits.surgeon.tools>
  | Tool.HandlersFor<typeof RoleToolkits.task.tools>

type ResolvedAgent = ExecutableResolver.StaticAgentExecutable["agent"]

/**
 * The exact values the Session's kernel is built from. The admitted profile pin is derived from
 * these and from nothing else, so a pin can never describe a kernel the host did not run.
 */
export interface KernelOptions {
  readonly runtimeVersion: string
  readonly dataRoot: string
  readonly limits?: KernelProfile.Limits
  readonly trustMode?: KernelProfile.TrustMode
}

export interface ConfigureOptions {
  readonly executionRoute: RouteSnapshot
  readonly workspace: string
  readonly kernel: KernelOptions
  readonly kernelPool?: Context.Context<KernelPool.KernelPool | CellCallContext.CellCallContext>
  readonly durableRuntime?: Effect.Effect<Option.Option<Runtime.Runtime["Service"]>>
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly agentServices?: Layer.Layer<AgentToolHandlers>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
}

export interface ConfiguredExecutable {
  readonly executable: ExecutableManifest.PinnedExecutable
  readonly registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly resolverEntries: ReadonlyArray<ExecutableResolver.StaticAgentExecutable>
  readonly profiles: Readonly<Record<string, AgentManifest.PinnedAgent>>
  readonly kernelProfile: KernelProfile.KernelProfile
}

export interface ResolverOptions {
  readonly kernel: KernelOptions
  readonly kernelPool?: Context.Context<KernelPool.KernelPool | CellCallContext.CellCallContext>
  readonly durableRuntime?: Effect.Effect<Option.Option<Runtime.Runtime["Service"]>>
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly agentServices?: (workspace: string) => Layer.Layer<AgentToolHandlers>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
}

const instructions = {
  root: "Work directly on the user's request. Inspect relevant evidence, make necessary changes, and verify the result.",
  title: "Return a concise title for the supplied request and nothing else.",
  Oracle: "Analyze the supplied problem deeply. Return a precise recommendation with risks and supporting reasoning.",
  Librarian: "Research the supplied question and return a concise evidence-backed report.",
  Painter: "Inspect the supplied visual material and return concrete implementation guidance.",
  ReadThread: "Find and summarize only the thread evidence needed to answer the supplied question.",
  Review: "Review the supplied request for the assigned lane. Return ordered findings with evidence and severity.",
  Surgeon: "Implement the bounded code change, preserve unrelated work, and verify the result.",
  Task: "Complete the bounded task autonomously and return the result with verification evidence.",
} as const

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
  own === instructions.title ? own : [own, "", surface].join("\n"),
)

const applicationPin = (route: RouteSnapshot, workspace: string) =>
  Pins.makeCapability({ ...Registration.codecs.applicationContext.identity, route, workspace })

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

const apiKey = (candidate: CandidateSnapshot) =>
  candidate.providerConnection.apiKeyEnvironment === undefined
    ? Config.succeed(Redacted.make(""))
    : Config.redacted(candidate.providerConnection.apiKeyEnvironment)

const storedCredentialApiKey = (
  candidate: CandidateSnapshot,
  store: ProviderCredentialStoreShape | undefined,
): Effect.Effect<Config.Config<Redacted.Redacted<string>>> => {
  const identity = candidate.providerConnection.credentialIdentity
  if (identity === undefined || store === undefined) return Effect.succeed(apiKey(candidate))
  return store.load(identity).pipe(
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
    Effect.map((credential) => (Option.isSome(credential) ? Config.succeed(credential.value) : apiKey(candidate))),
  )
}

const candidateRegistryLayer = (
  candidate: CandidateSnapshot,
  credentialStore: ProviderCredentialStoreShape | undefined,
): Layer.Layer<ModelRegistry.ModelRegistry, Config.ConfigError> => {
  const registrationKey = candidate.registrationIdentity
  switch (candidate.providerConnection.protocol) {
    case "openai":
      return OpenAi.layer({
        model: candidate.model,
        registrationKey,
        config: OpenAi.decodeConfig(candidate.providerOptions),
        apiKey: apiKey(candidate),
        clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
      }).pipe(Layer.provide(providerHttpClientLayer))
    case "anthropic":
      return Anthropic.layer({
        model: candidate.model,
        registrationKey,
        config: Anthropic.decodeConfig(candidate.providerOptions),
        apiKey: apiKey(candidate),
        clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
      }).pipe(Layer.provide(providerHttpClientLayer))
    case "openrouter":
      return Layer.unwrap(
        storedCredentialApiKey(candidate, credentialStore).pipe(
          Effect.map((resolvedApiKey) =>
            OpenRouter.layer({
              model: candidate.model,
              registrationKey,
              config: OpenRouter.decodeConfig(candidate.providerOptions),
              apiKey: resolvedApiKey,
              clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
            }).pipe(Layer.provide(providerHttpClientLayer)),
          ),
        ),
      )
    case "amazon-bedrock": {
      const connection = new URL(candidate.providerConnection.baseUrl)
      return AmazonBedrock.layer({
        model: candidate.model,
        registrationKey,
        config: AmazonBedrock.decodeConfig(candidate.providerOptions),
        client: {
          authMode: connection.searchParams.get("authMode") === "bearer" ? "bearer" : "default",
          ...(connection.searchParams.get("region") === null ? {} : { region: connection.searchParams.get("region")! }),
          ...(connection.searchParams.get("profile") === null
            ? {}
            : { profile: connection.searchParams.get("profile")! }),
          ...(connection.hostname === "default"
            ? {}
            : { endpoint: `${connection.protocol}//${connection.host}${connection.pathname}` }),
        },
      })
    }
    case "test":
      return Deterministic.layer({
        provider: candidate.providerConnection.provider,
        model: candidate.model,
        registrationKey,
      })
    default:
      throw new Error(`Unsupported Baton provider protocol ${candidate.providerConnection.protocol}`)
  }
}

const registrationsFrom = (layer: Layer.Layer<ModelRegistry.ModelRegistry>) =>
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
  credentialStore: ProviderCredentialStoreShape | undefined,
) =>
  Effect.gen(function* () {
    const available =
      override === undefined
        ? yield* Effect.forEach(route.candidates, (candidate) =>
            registrationsFrom(Layer.orDie(candidateRegistryLayer(candidate, credentialStore))),
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

/**
 * Every conversational agent (root and children alike) carries the same explicit budget, so a long
 * subagent is governed by its pinned Compaction policy exactly like the main agent instead of dying
 * from the runtime fallback's 1,000,000 cumulative token cap after ~17 turns. The shared cap is
 * generous (10x the fallback) and symmetric for root and children; a route-configured tokenBudget
 * still narrows totalTokens explicitly.
 */
const agentBudget = {
  modelCalls: 64,
  toolCalls: 256,
  totalTokens: 10_000_000,
  childRuns: 32,
  handoffs: 32,
  depth: 8,
} as const

const agentDefinition = (
  route: ModelSnapshot,
  routed: RoutedModel,
  name: string,
  agentInstructions: string,
  tools: ReadonlyArray<Tool.Any>,
  environment: AgentEnvironment,
  children: AgentManifest.AgentManifest["children"],
  applicationContextPin: ReturnType<typeof applicationPin>,
  compaction: AgentManifest.CompactionIdentity | undefined,
  tokenBudget: number | undefined,
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
      model: routed.selection,
      policy: TurnPolicy.both(TurnPolicy.recurs(80), TurnPolicy.forever),
      toolScheduling: tools.length === 0 ? { maxConcurrency: 1, parallelSafe: [] } : CellTool.scheduling,
      metadata: { productProfile: name },
      budget: { ...agentBudget, ...(tokenBudget === undefined ? {} : { totalTokens: tokenBudget }) },
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
    budget: agent.budget ?? {},
    children,
    ...(compaction === undefined ? {} : { compaction }),
  })
  return { agent: Agent.close(agent, environment), pinned }
}

const rootChildNames = ["Title", "Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const
const taskChildNames = ["Oracle", "Librarian", "Painter", "ReadThread", "Surgeon"] as const

type RoleName = "Root" | "Title" | "Oracle" | "Librarian" | "Painter" | "ReadThread" | "Review" | "Surgeon" | "Task"

/**
 * Every conversational profile advertises the one cell tool and nothing else. Title returns a
 * string and never acts, so it advertises no tool at all.
 */
const roleTools: Readonly<Record<RoleName, ReadonlyArray<Tool.Any>>> = {
  Root: [CellTool.tool],
  Title: [],
  Oracle: [CellTool.tool],
  Librarian: [CellTool.tool],
  Painter: [CellTool.tool],
  ReadThread: [CellTool.tool],
  Review: [CellTool.tool],
  Surgeon: [CellTool.tool],
  Task: [CellTool.tool],
}

const missingKernel = (tool: string) =>
  ToolExecutor.FrameworkFailure.make({
    stage: "handler",
    tool,
    message: "the typescript cell requires a kernel pool",
  })

/**
 * The pool arrives already built, owned by the composition root's own scope, because it outlives
 * every cell that uses it. Building it here instead would give it whichever cell forced it first,
 * and that cell's scope closes when it finishes — leaving every later cell holding a released map
 * that answers `RcMap.get` with an interrupt rather than a worker.
 *
 * Only `enter` is scoped per call: it registers this cell's identity for the duration of this cell
 * and must be removed when it ends. The durable Runtime is supplied around it rather than awaited
 * before it, so a host with no Runtime still runs cells and only `rika.agents` reports its absence.
 */
const cellExecutor = (
  pool: Context.Context<KernelPool.KernelPool | CellCallContext.CellCallContext>,
  runtime: Effect.Effect<Option.Option<Runtime.Runtime["Service"]>> | undefined,
): Layer.Layer<ToolExecutor.ToolExecutor> =>
  Layer.succeed(
    ToolExecutor.ToolExecutor,
    ToolExecutor.ToolExecutor.of({
      execute: (request) =>
        CellTool.route.matches(request)
          ? Effect.scoped(
              Effect.flatMap(runtime ?? Effect.succeedNone, (durable) =>
                Context.get(pool, CellCallContext.CellCallContext)
                  .enter(request.sessionId)
                  .pipe(
                    Option.isNone(durable) ? Function.identity : Effect.provideService(Runtime.Runtime, durable.value),
                    Effect.andThen(
                      CellTool.route
                        .execute(request)
                        .pipe(Effect.provideService(KernelPool.KernelPool, Context.get(pool, KernelPool.KernelPool))),
                    ),
                  ),
              ),
            )
          : missingKernel(request.call.name),
    }),
  )

const unavailableKernelExecutor: Layer.Layer<ToolExecutor.ToolExecutor> = Layer.succeed(
  ToolExecutor.ToolExecutor,
  ToolExecutor.ToolExecutor.of({ execute: (request) => missingKernel(request.call.name) }),
)

export interface ConfigureOptionsWithCredentialStore extends ConfigureOptions {
  readonly credentialStore?: ProviderCredentialStoreShape
}

export const configure = (
  options: ConfigureOptionsWithCredentialStore,
): Effect.Effect<
  ConfiguredExecutable,
  ModelRoute.AvailabilitySemanticsMissing | Errors.ExecutableRegistrationInvalid
> =>
  Effect.gen(function* () {
    const route = options.executionRoute
    const contextPin = applicationPin(route, options.workspace)
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
        routedModel(model, options.modelServices, options.credentialStore).pipe(
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
    const cellLayer =
      options.kernelPool === undefined
        ? unavailableKernelExecutor
        : cellExecutor(options.kernelPool, options.durableRuntime)
    const environment = (name: keyof typeof routes): AgentEnvironment => {
      const model = routed[name].layer
      if (name === "Title" || name === "Compaction") return Layer.orDie(model)
      return Layer.orDie(Layer.mergeAll(model, compactionLayer, cellLayer))
    }
    const supplemental = harnessSupplement(options.harnessSnapshot, options.skills ?? [])
    const cellSurface = BindingModules.cellInstructions({
      workspace: options.workspace,
      workspaceDigest: "",
      trustMode: options.kernel.trustMode ?? "trusted-local",
      servers: [],
    } as never)
    const withSurface = (own: string) =>
      supplemental === ""
        ? agentInstructionsWith(cellSurface, own)
        : agentInstructionsWith(`${cellSurface}\n\n${supplemental}`, own)
    const profileInstructions = {
      Title: instructions.title,
      Oracle: instructions.Oracle,
      Librarian: instructions.Librarian,
      Painter: instructions.Painter,
      ReadThread: instructions.ReadThread,
      Review: instructions.Review,
      Surgeon: instructions.Surgeon,
      Task: instructions.Task,
    } as const
    const leaf = (name: Exclude<keyof typeof profileInstructions, "Task">) =>
      agentDefinition(
        routes[name],
        routed[name],
        name,
        withSurface(profileInstructions[name]),
        roleTools[name],
        environment(name),
        [],
        contextPin,
        name === "Title" ? undefined : compactionIdentity,
        route.tokenBudget,
        name === "Title" ? undefined : kernelProfilePin,
        name === "Title" ? { skills: [], services: [] } : pinnedCapabilities,
      )
    const leafProfiles = {
      Title: leaf("Title"),
      Oracle: leaf("Oracle"),
      Librarian: leaf("Librarian"),
      Painter: leaf("Painter"),
      ReadThread: leaf("ReadThread"),
      Review: leaf("Review"),
      Surgeon: leaf("Surgeon"),
    }
    const task = agentDefinition(
      routes.Task,
      routed.Task,
      "Task",
      withSurface(profileInstructions.Task),
      roleTools.Task,
      environment("Task"),
      taskChildNames.map((selection) => ({ selection, agent: leafProfiles[selection].pinned.pin })),
      contextPin,
      compactionIdentity,
      route.tokenBudget,
      kernelProfilePin,
      pinnedCapabilities,
    )
    const profiles: Readonly<Record<keyof typeof profileInstructions, AgentDefinition>> = {
      ...leafProfiles,
      Task: task,
    }
    const profileNames = ["Title", "Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const
    const nestedNames = new Set<string>(rootChildNames)
    const root = agentDefinition(
      route.main,
      routed.Root,
      "Root",
      withSurface(instructions.root),
      roleTools.Root,
      environment("Root"),
      rootChildNames.map((selection) => ({ selection, agent: profiles[selection].pinned.pin })),
      contextPin,
      compactionIdentity,
      route.tokenBudget,
      kernelProfilePin,
      pinnedCapabilities,
    )
    const childEntries = rootChildNames.map((name) => agentEntry(profiles[name].pinned))
    const entries = [agentEntry(root.pinned), ...childEntries]
    const executable = ExecutableManifest.make({ root: root.pinned.pin, entries })
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
    const registeredToolkits: ReadonlyArray<Toolkit.Any> = [CellTool.toolkit]
    for (const toolkit of registeredToolkits) {
      for (const tool of Object.values(toolkit.tools)) {
        registrationMap.set(
          Registration.toolPin(tool),
          Registration.make(Registration.codecs.tool, Registration.toolPin(tool), Registration.toolPayload(tool)),
        )
      }
    }
    const registrations = yield* Effect.forEach(ExecutableRegistration.requiredPins(executable), (pin) => {
      const registration = registrationMap.get(pin)
      return registration === undefined
        ? Errors.ExecutableRegistrationInvalid.make({ message: `unregistered executable pin: ${pin}` })
        : Effect.succeed(registration)
    })
    return {
      kernelProfile,
      executable,
      registrations,
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
        ...profileNames.map((name) => {
          const definition = profiles[name]
          const resolved = {
            executable: nestedNames.has(name)
              ? ExecutableManifest.make({ root: root.pinned.pin, active: definition.pinned.pin, entries })
              : ExecutableManifest.make({ root: definition.pinned.pin, entries: [agentEntry(definition.pinned)] }),
            agent: definition.agent,
          }
          return name === "Title"
            ? resolved
            : Object.assign(resolved, {
                runOptions: {
                  compaction: {
                    contextWindow: route.main.compaction.contextWindow,
                    reserveTokens: route.main.compaction.reserveTokens,
                  },
                },
              })
        }),
      ],
      profiles: Object.fromEntries(Object.entries(profiles).map(([name, definition]) => [name, definition.pinned])),
    }
  })

const invalid = (cause: unknown) => Errors.ExecutableRegistrationInvalid.make({ message: String(cause) })

export interface ResolverOptionsWithCredentialStore extends ResolverOptions {
  readonly credentialStore?: ProviderCredentialStoreShape
}

export const makeResolver = (options: ResolverOptionsWithCredentialStore): ExecutableResolver.Interface =>
  ExecutableResolver.ExecutableResolver.of({
    resolve: (input) =>
      Effect.gen(function* () {
        const active = input.manifest.entries.find((entry) => entry.pin === input.ref.active)
        if (active === undefined) return yield* Errors.ExecutablePinMissing.make({ runId: input.runId, ref: input.ref })
        const context = yield* Registration.read(Registration.codecs.applicationContext, input.registrations)
        const configured = yield* configure({
          executionRoute: context.executionRoute,
          workspace: context.workspace,
          kernel: options.kernel,
          ...(options.kernelPool === undefined ? {} : { kernelPool: options.kernelPool }),
          ...(options.durableRuntime === undefined ? {} : { durableRuntime: options.durableRuntime }),
          ...(options.skills === undefined ? {} : { skills: options.skills }),
          ...(options.harnessSnapshot === undefined ? {} : { harnessSnapshot: options.harnessSnapshot }),
          ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
          ...(options.agentServices === undefined ? {} : { agentServices: options.agentServices(context.workspace) }),
          ...(options.modelServices === undefined ? {} : { modelServices: options.modelServices }),
        }).pipe(Effect.mapError(invalid))
        yield* Registration.verify({
          expected: configured.registrations,
          actual: input.registrations,
          required: ExecutableRegistration.requiredPinsForActiveExecutable({
            ref: input.ref,
            manifest: input.manifest,
          }),
        })
        return yield* ExecutableResolver.makeStatic(configured.resolverEntries).resolve(input)
      }),
  })
