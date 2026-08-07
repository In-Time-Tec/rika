import {
  Agent,
  AgentManifest,
  Compaction,
  ExecutableManifest,
  LanguageModel,
  ModelRegistry,
  Pins,
  ProgramManifest,
  SandboxExecutor,
  ToolExecutor,
  TurnPolicy,
} from "@batonfx/core"
import { AmazonBedrock, Anthropic, Deterministic, ModelRoute, OpenAi } from "@batonfx/providers"
import { ChildRuns, Errors, ExecutableRegistration, ExecutableResolver } from "@batonfx/runtime"
import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import { Config, Context, Effect, Layer, Option, Redacted, Scope } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import * as Program from "./baton-program"
import * as ProgramBindings from "./baton-program-bindings"
import * as Registration from "./baton-registration"
import * as Sandbox from "./baton-sandbox-identity"

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

type ProgramToolHandlers = Tool.HandlersFor<typeof Program.toolkit.tools>

type ResolvedAgent = ExecutableResolver.StaticAgentExecutable["agent"]

export interface ConfigureOptions {
  readonly executionRoute: RouteSnapshot
  readonly workspace: string
  readonly sandbox: SandboxExecutor.Interface
  readonly agentServices?: Layer.Layer<AgentToolHandlers>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
}

export interface ConfiguredExecutable {
  readonly executable: ExecutableManifest.PinnedExecutable
  readonly registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly resolverEntries: ReadonlyArray<ExecutableResolver.StaticAgentExecutable>
  readonly profiles: Readonly<Record<string, AgentManifest.PinnedAgent>>
  readonly programAuthority: AgentManifest.ProgramAuthority
}

export interface ResolverOptions {
  readonly sandbox: SandboxExecutor.Interface
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

const candidateRegistryLayer = (candidate: CandidateSnapshot) => {
  const registrationKey = candidate.registrationIdentity
  switch (candidate.providerConnection.protocol) {
    case "openai":
      return OpenAi.layer({
        model: candidate.model,
        registrationKey,
        config: OpenAi.decodeConfig(candidate.providerOptions),
        apiKey: apiKey(candidate),
        clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
      }).pipe(Layer.provide(FetchHttpClient.layer))
    case "anthropic":
      return Anthropic.layer({
        model: candidate.model,
        registrationKey,
        config: Anthropic.decodeConfig(candidate.providerOptions),
        apiKey: apiKey(candidate),
        clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
      }).pipe(Layer.provide(FetchHttpClient.layer))
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

const routedModel = (route: ModelSnapshot, override?: Layer.Layer<ModelRegistry.ModelRegistry>) =>
  Effect.gen(function* () {
    const available =
      override === undefined
        ? yield* Effect.forEach(route.candidates, (candidate) =>
            registrationsFrom(Layer.orDie(candidateRegistryLayer(candidate))),
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
  tools: ReadonlyArray<Tool.Any>,
  environment: AgentEnvironment,
  children: AgentManifest.AgentManifest["children"],
  applicationContextPin: ReturnType<typeof applicationPin>,
  compaction: AgentManifest.CompactionIdentity | undefined,
  tokenBudget: number | undefined,
  programAuthority?: AgentManifest.ProgramAuthority,
): AgentDefinition => {
  const agent = Agent.withTools(
    Agent.make({
      name: `rika-${name.toLowerCase()}`,
      instructions: agentInstructions,
      model: routed.selection,
      policy: TurnPolicy.both(TurnPolicy.recurs(80), TurnPolicy.forever),
      toolScheduling: {
        maxConcurrency: 4,
        parallelSafe: tools.map((tool) => tool.name).filter((toolName) => parallelSafeToolNames.has(toolName)),
      },
      metadata: { productProfile: name },
      ...(tokenBudget === undefined ? {} : { budget: { totalTokens: tokenBudget } }),
    }),
    tools,
  )
  const pinned = AgentManifest.fromLiveAgent(agent, {
    model: modelPin(route),
    tools: toolPins(agent.toolkit),
    skills: [],
    services: [
      { name: "model-registry", pin: modelRegistryPin(route) },
      { name: "rika-application-context", pin: applicationContextPin },
      ...(compaction === undefined ? [] : [{ name: "compaction", pin: compaction.service }]),
    ],
    policy: { _tag: "Portable", policy: agent.policy.snapshot! },
    budget: agent.budget ?? {},
    children,
    ...(compaction === undefined ? {} : { compaction }),
    ...(programAuthority === undefined ? {} : { programAuthority }),
  })
  return { agent: Agent.close(agent, environment), pinned }
}

const parallelSafeToolNames = new Set([
  "grep",
  "read",
  "web_search",
  "read_web_page",
  "view_media",
  "search_threads",
  "read_thread_transcript",
  "find_thread",
])

const rootChildNames = ["Title", "Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const
const taskChildNames = ["Oracle", "Librarian", "Painter", "ReadThread", "Surgeon"] as const

const childTools = {
  Root: ChildRuns.makeTools({ children: rootChildNames.map((selection) => ({ selection })) }),
  Task: ChildRuns.makeTools({ children: taskChildNames.map((selection) => ({ selection })) }),
} as const

const withChildTools = <Tools extends Record<string, Tool.Any>>(
  base: Toolkit.Toolkit<Tools>,
  children: ReturnType<typeof ChildRuns.makeTools>,
) => Toolkit.make(...Object.values(base.tools), children.runChild, children.startChildGroup, children.awaitChildGroup)

const rootToolkit = withChildTools(RoleToolkits.root, childTools.Root)
const taskToolkit = withChildTools(RoleToolkits.task, childTools.Task)

const roleTools: Readonly<Record<RoleName, ReadonlyArray<Tool.Any>>> = {
  Root: Object.values(rootToolkit.tools),
  Title: [],
  Oracle: Object.values(RoleToolkits.oracle.tools),
  Librarian: Object.values(RoleToolkits.librarian.tools),
  Painter: Object.values(RoleToolkits.painter.tools),
  ReadThread: Object.values(RoleToolkits.readThread.tools),
  Review: Object.values(RoleToolkits.oracle.tools),
  Surgeon: Object.values(RoleToolkits.surgeon.tools),
  Task: Object.values(taskToolkit.tools),
}

type RoleName = "Root" | "Title" | "Oracle" | "Librarian" | "Painter" | "ReadThread" | "Review" | "Surgeon" | "Task"

type ExecutorRole = Exclude<RoleName, "Title">

type RoleExecutor = (handlers: Layer.Layer<AgentToolHandlers>) => Layer.Layer<ToolExecutor.ToolExecutor>

const missingChildHost = (tool: string) =>
  ToolExecutor.FrameworkFailure.make({
    stage: "handler",
    tool,
    message: "child Agent tools require the Baton execution host",
  })

const roleExecutor = <Tools extends Record<string, Tool.Any>>(
  codingTools: Toolkit.Toolkit<Tools>,
  includeChildTools: boolean,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>>,
): Layer.Layer<ToolExecutor.ToolExecutor> =>
  Layer.effect(
    ToolExecutor.ToolExecutor,
    ToolExecutor.routeToolkit(codingTools).pipe(
      Effect.map((codingRoute) =>
        ToolExecutor.ToolExecutor.of({
          execute: (request) => {
            if (!includeChildTools || !ChildRuns.route.matches(request)) return codingRoute.execute(request)
            return Effect.serviceOption(ChildRuns.ChildRuns).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => missingChildHost(request.call.name),
                  onSome: (children) =>
                    ChildRuns.route.execute(request).pipe(Effect.provideService(ChildRuns.ChildRuns, children)),
                }),
              ),
            )
          },
        }),
      ),
    ),
  ).pipe(Layer.provide(handlers))

const roleExecutors: Readonly<Record<ExecutorRole, RoleExecutor>> = {
  Root: (handlers) => roleExecutor(RoleToolkits.root, true, handlers),
  Oracle: (handlers) => roleExecutor(RoleToolkits.oracle, false, handlers),
  Librarian: (handlers) => roleExecutor(RoleToolkits.librarian, false, handlers),
  Painter: (handlers) => roleExecutor(RoleToolkits.painter, false, handlers),
  ReadThread: (handlers) => roleExecutor(RoleToolkits.readThread, false, handlers),
  Review: (handlers) => roleExecutor(RoleToolkits.oracle, false, handlers),
  Surgeon: (handlers) => roleExecutor(RoleToolkits.surgeon, false, handlers),
  Task: (handlers) => roleExecutor(RoleToolkits.task, true, handlers),
}

export const configure = (
  options: ConfigureOptions,
): Effect.Effect<
  ConfiguredExecutable,
  ModelRoute.AvailabilitySemanticsMissing | Errors.ExecutableRegistrationInvalid
> =>
  Effect.gen(function* () {
    const sandboxIdentity = yield* Sandbox.decode(options.sandbox)
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
        routedModel(model, options.modelServices).pipe(Effect.map((value) => [name, value] as const)),
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
    const environment = (name: keyof typeof routes): AgentEnvironment => {
      const model = routed[name].layer
      if (name === "Title" || name === "Compaction") return Layer.orDie(model)
      const handlers = options.agentServices
      return Layer.orDie(
        handlers === undefined
          ? Layer.mergeAll(model, compactionLayer)
          : Layer.mergeAll(model, compactionLayer, roleExecutors[name](handlers)),
      )
    }
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
        profileInstructions[name],
        roleTools[name],
        environment(name),
        [],
        contextPin,
        name === "Title" ? undefined : compactionIdentity,
        route.tokenBudget,
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
      profileInstructions.Task,
      roleTools.Task,
      environment("Task"),
      taskChildNames.map((selection) => ({ selection, agent: leafProfiles[selection].pinned.pin })),
      contextPin,
      compactionIdentity,
      route.tokenBudget,
    )
    const profiles: Readonly<Record<keyof typeof profileInstructions, AgentDefinition>> = {
      ...leafProfiles,
      Task: task,
    }
    const profileNames = ["Title", "Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const
    const nestedNames = new Set<string>(rootChildNames)
    const programAuthority = Program.authority({
      workspace: options.workspace,
      sandbox: sandboxIdentity,
      tools: toolPins(Program.toolkit),
      agents: Program.agentSelections.map((selection) => ({
        selection,
        agent: profiles[selection].pinned.pin,
      })),
    })
    const root = agentDefinition(
      route.main,
      routed.Root,
      "Root",
      instructions.root,
      roleTools.Root,
      environment("Root"),
      rootChildNames.map((selection) => ({ selection, agent: profiles[selection].pinned.pin })),
      contextPin,
      compactionIdentity,
      route.tokenBudget,
      programAuthority,
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
      programAuthority.sandbox,
      Registration.make(
        Registration.codecs.programSandbox,
        programAuthority.sandbox,
        Sandbox.payload(sandboxIdentity, options.workspace),
      ),
    )
    registrationMap.set(
      Program.pins.input,
      Registration.make(Registration.codecs.programInput, Program.pins.input, {
        schema: Program.schemas.inputDocument,
      }),
    )
    registrationMap.set(
      Program.pins.output,
      Registration.make(Registration.codecs.programOutput, Program.pins.output, {
        schema: Program.schemas.outputDocument,
      }),
    )
    registrationMap.set(
      Program.pins.agentInput,
      Registration.make(Registration.codecs.programAgentInput, Program.pins.agentInput, {
        schema: Program.schemas.agentInputDocument,
      }),
    )
    const registeredToolkits: ReadonlyArray<Toolkit.Any> = [
      rootToolkit,
      RoleToolkits.oracle,
      RoleToolkits.librarian,
      RoleToolkits.painter,
      RoleToolkits.readThread,
      RoleToolkits.oracle,
      RoleToolkits.surgeon,
      taskToolkit,
    ]
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
      programAuthority,
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

const programCall = (
  runId: string,
  services: Layer.Layer<ProgramToolHandlers>,
): Effect.Effect<ProgramBindings.ToolCall, never, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(services)
    const route = yield* ToolExecutor.routeToolkit(Program.toolkit).pipe(Effect.provide(context))
    const signal = yield* Effect.abortSignal
    return {
      route,
      context: { signal, emit: () => Effect.void, sessionId: runId, runId },
      sessionId: runId,
    }
  })

const resolveProgram = (
  options: ResolverOptions,
  input: ExecutableResolver.Input,
  program: ProgramManifest.ProgramManifest,
): Effect.Effect<
  ExecutableResolver.Resolution,
  Errors.ExecutablePinMissing | Errors.ExecutableRegistrationInvalid | Errors.ExecutableRegistrationMissing,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const identity = yield* Sandbox.decode(options.sandbox)
    const registration = input.registrations.find(({ pin }) => pin === program.sandbox)
    if (registration === undefined) return yield* Errors.ExecutableRegistrationMissing.make({ pin: program.sandbox })
    const persisted = yield* Registration.decode(Registration.codecs.programSandbox, registration)
    const services = options.agentServices === undefined ? undefined : options.agentServices(persisted.workspace)
    const call = services === undefined ? undefined : yield* programCall(input.runId, services)
    return yield* ExecutableResolver.makeDynamic({
      agents: [],
      program: ProgramBindings.reconstruction({
        workspace: persisted.workspace,
        identity,
        call,
        sandbox: options.sandbox,
      }),
    }).resolve(input)
  })

export const makeResolver = (options: ResolverOptions): ExecutableResolver.Interface =>
  ExecutableResolver.ExecutableResolver.of({
    resolve: (input) =>
      Effect.gen(function* () {
        const active = input.manifest.entries.find((entry) => entry.pin === input.ref.active)
        if (active === undefined) return yield* Errors.ExecutablePinMissing.make({ runId: input.runId, ref: input.ref })
        if (active._tag === "Program") return yield* resolveProgram(options, input, active.manifest)
        const context = yield* Registration.read(Registration.codecs.applicationContext, input.registrations)
        const configured = yield* configure({
          executionRoute: context.executionRoute,
          workspace: context.workspace,
          sandbox: options.sandbox,
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
