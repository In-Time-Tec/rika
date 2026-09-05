import { ExecutableResolver, Errors, ExecutableRegistration } from "generalist/runtime"
import { Effect } from "effect"
import * as Registration from "../registration"
import { configure } from "./route-configuration"
import { resolveToolRoute } from "./route-domain"
import type { ConfigureOptions, ResolverOptions } from "./route-domain"

export { agentInstructionsWith, profileInstructions } from "./route-domain"
export type {
  ConfiguredExecutable,
  ConfigureOptions,
  RemoteToolRoute,
  ResolverOptions,
  ToolRoute,
} from "./route-domain"
export { configure } from "./route-configuration"

const invalid = (cause: unknown) => Errors.ExecutableRegistrationInvalid.make({ message: String(cause) })

export const makeResolver = (options: ResolverOptions): ExecutableResolver.Service =>
  ExecutableResolver.ExecutableResolver.of({
    resolve: (input) =>
      Effect.gen(function* () {
        const active = input.manifest.entries.find((entry) => entry.pin === input.ref.active)
        if (active === undefined) return yield* Errors.ExecutablePinMissing.make({ runId: input.runId, ref: input.ref })
        const context = yield* Registration.read(Registration.codecs.applicationContext, input.registrations)
        const capabilities =
          options.capabilities === undefined ? undefined : yield* options.capabilities(context.workspace)
        const configureOptions: ConfigureOptions = {
          executionRoute: context.executionRoute,
          workspace: context.workspace,
          mcp: context.mcp ?? [],
        }
        if (context.executionIdentity !== undefined)
          Object.assign(configureOptions, { executionIdentity: context.executionIdentity })
        Object.assign(configureOptions, { tools: resolveToolRoute(options.tools) })
        if (capabilities !== undefined)
          Object.assign(configureOptions, {
            skills: capabilities.skills,
            harnessSnapshot: capabilities.harnessSnapshot,
          })
        if (options.credentialStore !== undefined)
          Object.assign(configureOptions, { credentialStore: options.credentialStore })
        if (options.openAiAccountAccess !== undefined)
          Object.assign(configureOptions, { openAiAccountAccess: options.openAiAccountAccess })
        if (options.modelServices !== undefined)
          Object.assign(configureOptions, { modelServices: options.modelServices })
        const configured = yield* configure(configureOptions).pipe(Effect.mapError(invalid))
        yield* Registration.verify({
          expected: [...configured.registrations, ...configured.titleRegistrations],
          actual: input.registrations,
          required: ExecutableRegistration.requiredPinsForActiveExecutable({
            ref: input.ref,
            manifest: input.manifest,
          }),
        })
        const resolver = yield* ExecutableResolver.makeStatic(configured.resolverEntries)
        return yield* resolver.resolve(input)
      }),
  })
