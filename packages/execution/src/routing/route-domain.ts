import { Agent, AgentManifest, ExecutableManifest, ModelRegistry, Pins } from "generalist"
import * as ModelRoute from "generalist/ai/model-route"
import { Errors, ExecutableRegistration, ExecutableResolver } from "generalist/runtime"
import type { State } from "generalist/instructions"
import * as NativeTools from "../tool/registry"
import * as HarnessPromptSections from "../harness/prompt-sections"
import * as ExecutionPins from "../harness/execution-pins"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import type { ProviderCredentialStoreService } from "@rika/product/provider-credential-store"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import { Context, Effect, Function, Layer } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { nativeToolInstructions, profileInstructions } from "../agent-instructions"
import * as Models from "../models"
import * as Registration from "../registration"
import * as RemoteTools from "../remote-tools"

type ModelSnapshot = ExecutionRoute.ExecutionRouteModelSnapshot
type RouteSnapshot = ExecutionRoute.ExecutionRouteSnapshot

export interface RemoteToolRoute {
  readonly _tag: "Remote"
  readonly tools: Layer.Layer<RemoteTools.Service>
  readonly admit: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly workspaceId: string
  }) => Effect.Effect<void, RemoteTools.AdmissionFailure>
}

export type ToolRoute = { readonly _tag: "Local" } | RemoteToolRoute

export const resolveToolRoute = (route: RemoteToolRoute | undefined): ToolRoute => route ?? { _tag: "Local" }

export interface ConfigureOptions {
  readonly executionRoute: RouteSnapshot
  readonly workspace: string
  readonly executionIdentity?: {
    readonly threadId: string
    readonly turnId: string
  }
  readonly tools?: ToolRoute
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: State.GuidanceState
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreService
  readonly openAiAccountAccess?: (credentialIdentity: string) => OpenAiAuth.CredentialAccess
}

export interface ConfiguredExecutable {
  readonly executable: ExecutableManifest.PinnedExecutable
  readonly titleExecutable: ExecutableManifest.PinnedExecutable
  readonly registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly titleRegistrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly resolverEntries: ReadonlyArray<ExecutableResolver.StaticAgentExecutable>
  readonly profiles: Readonly<Record<string, AgentManifest.PinnedAgent>>
}

export interface ResolverOptions {
  readonly tools?: RemoteToolRoute
  readonly capabilities?: (workspace: string) => Effect.Effect<{
    readonly skills: ReadonlyArray<ExecutionPins.SkillPin>
    readonly harnessSnapshot: State.GuidanceState
  }>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreService
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

export { profileInstructions }

/**
 * Every conversational agent receives the native workspace surface. The Title agent carries no tools,
 * so it keeps the one sentence it was given rather than a surface it cannot use.
 */
/**
 * What one Execution's harness adds to the prompt every agent in it reads. An absent harness adds
 * nothing rather than an empty section, so a session with no refinements looks exactly as it did.
 */
const harnessSupplement = (
  harness: State.GuidanceState | undefined,
  skills: ReadonlyArray<ExecutionPins.SkillPin>,
): string =>
  harness === undefined
    ? ""
    : HarnessPromptSections.block({
        harness,
        skillListings: skills.map((skill) => `- ${skill.name}`).join("\n"),
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
) => {
  const payload = Object.assign(
    { ...Registration.codecs.applicationContext.identity, route, workspace },
    executionIdentity === undefined ? undefined : { executionIdentity },
  )
  return Pins.makeCapability(payload)
}

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
  Object.values(toolkit.tools).map((tool) => {
    const payload = Registration.toolPayload(tool)
    return { name: payload.name, pin: Registration.toolPin(tool) }
  })

const agentEntry = (pinned: AgentManifest.PinnedAgent): ExecutableManifest.AgentEntry => ({
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
): Effect.Effect<RoutedModel, ModelRoute.AvailabilitySemanticsMissing | Errors.ExecutableRegistrationInvalid> =>
  Effect.gen(function* () {
    const registrationFor = (candidate: ModelSnapshot["candidates"][number]) => {
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
    }
    const available =
      override === undefined
        ? yield* Effect.forEach(route.candidates, (candidate) =>
            registrationsFrom(
              Models.layer(
                Object.assign(
                  { candidate },
                  credentialStore === undefined ? undefined : { credentialStore },
                  openAiAccountAccess === undefined ? undefined : { openAiAccountAccess },
                ),
              ),
            ).pipe(Effect.mapError((cause) => Errors.ExecutableRegistrationInvalid.make({ message: String(cause) }))),
          ).pipe(Effect.map((groups) => groups.flat()))
        : yield* registrationsFrom(override)
    const [firstCandidate, ...remainingCandidates] = route.candidates
    if (firstCandidate === undefined) throw new Error("Model route requires at least one candidate")
    const candidates = [registrationFor(firstCandidate), ...remainingCandidates.map(registrationFor)] satisfies [
      ModelRegistry.Registration,
      ...Array<ModelRegistry.Registration>,
    ]
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
  capabilities: {
    readonly skills: ReadonlyArray<AgentManifest.NamedCapability>
    readonly services: ReadonlyArray<AgentManifest.NamedCapability>
  },
): AgentDefinition => {
  const agentOptions = {
    name: `rika-${name.toLowerCase()}`,
    instructions: agentInstructions,
    model: routed.selection,
    toolScheduling: tools.length === 0 ? { maxConcurrency: 1, parallelSafe: [] } : NativeTools.scheduling,
    metadata: { productProfile: name },
    budget: unlimitedBudget,
  }
  if (supplementalInstructions !== undefined) Object.assign(agentOptions, { supplemental: supplementalInstructions })
  const agent = Agent.withTools(Agent.make(agentOptions), tools)
  const policy = {
    _tag: "Portable",
    policy: agent.policy.snapshot!,
  } satisfies AgentManifest.AgentManifest["policy"]
  const manifestOptions = {
    model: modelPin(route),
    tools: toolPins(agent.toolkit),
    skills: capabilities.skills,
    services: [
      { name: "model-registry", pin: modelRegistryPin(route) },
      { name: "rika-application-context", pin: applicationContextPin },
      ...(compaction === undefined ? [] : [{ name: "compaction", pin: compaction.service }]),
      ...capabilities.services,
    ],
    policy,
    budget: unlimitedBudget,
    children,
  }
  if (compaction !== undefined) Object.assign(manifestOptions, { compaction })
  const pinned = AgentManifest.fromLiveAgent(agent, manifestOptions)
  return { agent: Agent.close(agent, environment), pinned }
}

const rootChildNames = ["Oracle", "Librarian", "Painter", "Review", "Surgeon", "Task"] as const
type ChildProfileName = (typeof rootChildNames)[number]

export const routeDomain = {
  agentDefinition,
  agentEntry,
  agentInstructionsWith,
  applicationPin,
  compactionPin,
  harnessSupplement,
  modelPin,
  modelRegistryPin,
  nativeToolInstructions,
  profileInstructions,
  rootChildNames,
  routedModel,
}
export type { AgentDefinition, AgentEnvironment, ChildProfileName, ModelSnapshot, RouteSnapshot }
