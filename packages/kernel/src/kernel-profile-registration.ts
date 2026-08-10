import { Pins } from "@batonfx/core"
import { KernelProfile } from "@batonfx/repl"
import { bindingsDigest, type Environment } from "./binding/binding-epoch"

const runtimeName = "bun"

export const defaultLimits: KernelProfile.Limits = {
  sourceBytes: 65_536,
  channelBytes: 262_144,
  cellDeadlineMillis: 120_000,
}

export interface Options {
  readonly runtimeVersion: string
  readonly workspace: string
  readonly dataRoot: string
  readonly runtimeDigest?: string
  readonly limits?: KernelProfile.Limits
  readonly trustMode?: KernelProfile.TrustMode
  readonly environment?: Environment
}

/**
 * Build the profile one kernel epoch is reconstructed from.
 *
 * The bindings digest covers the mounted module names, the bootstrap source, AND the environment a
 * cell can import or reach, so evolving the `rika` surface — adding an operation, renaming a module,
 * changing how the object is assembled, adding an executable skill, enabling an MCP server — yields
 * a different digest and therefore a new epoch rather than a worker running a stale surface.
 */
export const make = (options: Options): KernelProfile.KernelProfile =>
  KernelProfile.make({
    runtime: {
      name: runtimeName,
      version: options.runtimeVersion,
      digest: options.runtimeDigest ?? Pins.digest({ name: runtimeName, version: options.runtimeVersion }),
    },
    bindingsDigest: bindingsDigest(options.environment),
    workspace: { root: options.workspace, dataRoot: options.dataRoot },
    limits: options.limits ?? defaultLimits,
    trustMode: options.trustMode ?? "trusted-local",
  })

/** Content-addressed identity of one profile. A different digest requires a new epoch. */
export const digest = (profile: KernelProfile.KernelProfile): string => KernelProfile.digest(profile)

/** The capability pin a host records so a replayed Execution reconstructs this exact kernel epoch. */
export const pin = (profile: KernelProfile.KernelProfile): string =>
  Pins.makeCapability({ capability: "rika-kernel-profile", version: "1", digest: digest(profile) })
