import { ExecutableResolver, Errors, ExecutableRegistration } from "tenetkit/runtime"
import { Effect } from "effect"
import * as Registration from "../registration"
import { configure } from "./route-configuration"
import { resolveCellRoute } from "./route-domain"
import type { ConfigureOptions, ResolverOptions } from "./route-domain"

export { agentInstructionsWith, profileInstructions, resolveCellRoute } from "./route-domain"
export type {
  CellResolver,
  CellRoute,
  ConfiguredExecutable,
  ConfigureOptions,
  KernelOptions,
  LocalCellResolver,
  LocalCellRoute,
  LocalCellServices,
  RemoteCellRoute,
  ResolverOptions,
} from "./route-domain"
export { remoteCellOperationOutcome } from "./route-cells"
export type { RemoteCellOperationOutcome } from "./route-cells"
export { configure } from "./route-configuration"

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
        const configureOptions: ConfigureOptions = {
          executionRoute: context.executionRoute,
          workspace: context.workspace,
          kernel: options.kernel,
        }
        if (context.executionIdentity !== undefined)
          Object.assign(configureOptions, { executionIdentity: context.executionIdentity })
        if (cell !== undefined) Object.assign(configureOptions, { cell })
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
        return yield* ExecutableResolver.makeStatic(configured.resolverEntries).resolve(input)
      }),
  })
