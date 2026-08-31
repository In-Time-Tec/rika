import { AgentManifest, Compaction, ExecutableManifest, LanguageModel, ModelRegistry, Pins } from "generalist"
import * as ModelRoute from "generalist/ai/model-route"
import { Errors, ExecutableRegistration } from "generalist/runtime"
import { CellTool } from "generalist/repl"
import * as BindingModules from "@rika/kernel/binding-modules"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import { Effect, Layer, Schema } from "effect"
import { routeDomain } from "./route-domain"
import type {
  AgentDefinition,
  AgentEnvironment,
  ChildProfileName,
  ConfigureOptions,
  ConfiguredExecutable,
  ModelSnapshot,
} from "./route-domain"
import { cellRouting } from "./route-cells"
import * as Registration from "../registration"

const {
  agentDefinition,
  agentEntry,
  agentInstructionsWith,
  applicationPin,
  compactionPin,
  harnessSupplement,
  modelPin,
  modelRegistryPin,
  profileInstructions,
  rootChildNames,
  routedModel,
} = routeDomain
const { cellExecutor, remoteCellExecutor, unavailableCellExecutor } = cellRouting

const kernelProfileFor = (options: ConfigureOptions) =>
  KernelProfileRegistration.make(
    Object.assign(
      {
        runtimeVersion: options.kernel.runtimeVersion,
        workspace: options.workspace,
        dataRoot: options.kernel.dataRoot,
      },
      options.kernel.limits === undefined ? undefined : { limits: options.kernel.limits },
    ),
  )

const harnessPinsFor = (options: ConfigureOptions) =>
  options.harnessSnapshot === undefined
    ? { capabilities: [], registrations: [] }
    : ExecutionPins.harness(options.harnessSnapshot)

const cellLayerFor = (options: ConfigureOptions) => {
  const deadline =
    options.kernel.limits?.cellDeadlineMillis ?? KernelProfileRegistration.defaultLimits.cellDeadlineMillis
  if (options.cell?._tag === "Local") return cellExecutor(options.cell.services, deadline)
  if (options.cell?._tag === "Remote")
    return remoteCellExecutor(options.cell, options.workspace, options.executionIdentity, deadline)
  return unavailableCellExecutor
}

const mountedModulesFor = (options: ConfigureOptions) =>
  options.cell === undefined
    ? []
    : BindingModules.make({
        workspace: options.workspace,
        workspaceDigest: "",
        trustMode: options.kernel.trustMode ?? "trusted-local",
        servers: [],
      })

const optionalSupplement = (supplement: string) => (supplement === "" ? undefined : supplement)

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
    const routeModel = (model: ModelSnapshot) =>
      routedModel(model, options.modelServices, options.credentialStore, options.openAiAccountAccess)
    const routed = yield* Effect.all({
      Root: routeModel(routes.Root),
      Title: routeModel(routes.Title),
      Compaction: routeModel(routes.Compaction),
      Oracle: routeModel(routes.Oracle),
      Librarian: routeModel(routes.Librarian),
      Painter: routeModel(routes.Painter),
      ReadThread: routeModel(routes.ReadThread),
      Review: routeModel(routes.Review),
      Surgeon: routeModel(routes.Surgeon),
      Task: routeModel(routes.Task),
    })
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
      ModelRegistry.withModel(
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
    const kernelProfile = kernelProfileFor(options)
    const kernelProfilePin = yield* Schema.decodeEffect(Pins.CapabilityPin)(
      KernelProfileRegistration.pin(kernelProfile),
    ).pipe(Effect.mapError((cause) => Errors.ExecutableRegistrationInvalid.make({ message: String(cause) })))
    const skillPins = ExecutionPins.skills(options.skills ?? [])
    const harnessPins = harnessPinsFor(options)
    const pinnedCapabilities = { skills: skillPins.capabilities, services: harnessPins.capabilities }
    const cellLayer = cellLayerFor(options)
    const environment = (name: keyof typeof routes): AgentEnvironment => {
      const model = routed[name].layer
      if (name === "Title" || name === "Compaction") return Layer.orDie(model)
      return Layer.orDie(Layer.mergeAll(model, compactionLayer, cellLayer))
    }
    const supplemental = harnessSupplement(options.harnessSnapshot, options.skills ?? [])
    const mountedModules = mountedModulesFor(options)
    const limits = options.kernel.limits ?? KernelProfileRegistration.defaultLimits
    const cellSurface = BindingModules.cellInstructions({
      modules: mountedModules,
      workspace: options.workspace,
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
        optionalSupplement(supplemental),
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
    const childDefinitions = {
      Oracle: childDefinitionFor("Oracle"),
      Librarian: childDefinitionFor("Librarian"),
      Painter: childDefinitionFor("Painter"),
      ReadThread: childDefinitionFor("ReadThread"),
      Review: childDefinitionFor("Review"),
      Surgeon: childDefinitionFor("Surgeon"),
      Task: childDefinitionFor("Task"),
    } satisfies Readonly<Record<ChildProfileName, AgentDefinition>>
    const root = agentDefinition(
      route.main,
      routed.Root,
      "Root",
      withSurface(profileInstructions.root),
      optionalSupplement(supplemental),
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
      Registration.make(
        Registration.codecs.applicationContext,
        contextPin,
        Object.assign(
          {
            workspace: options.workspace,
            executionRoute: route,
          },
          options.executionIdentity === undefined ? undefined : { executionIdentity: options.executionIdentity },
        ),
      ),
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
