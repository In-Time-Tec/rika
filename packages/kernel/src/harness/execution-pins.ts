import { Pins, type AgentManifest } from "generalist"
import { Snapshot, State } from "generalist/instructions"
import { Schema } from "effect"

/**
 * One registration record a durable host must supply for every Execution of the manifest that pins
 * it. This mirrors Generalist's `ExecutableRegistration` shape without importing the runtime: the kernel
 * describes what must be registered, and the execution adapter records it.
 */
export interface Registration {
  readonly pin: string
  readonly codec: string
  readonly version: string
  readonly payload: Schema.Json
}

export interface Pinned {
  readonly capabilities: ReadonlyArray<AgentManifest.NamedCapability>
  readonly registrations: ReadonlyArray<Registration>
}

/** One skill the Execution's identity is pinned to. */
export interface SkillPin {
  readonly name: string
  readonly digest: string
  readonly importName?: string
}

const SKILL_CODEC = "rika-skill"
const SKILL_VERSION = "1"

/**
 * Turn discovered skills into the manifest capabilities and registrations that make a skill part of
 * an Execution's durable identity.
 *
 * The execution route pinned `skills: []`, so no skill has ever reached an executing Agent. Pinning the
 * NAME and DIGEST — never the body — means the skill set is reconstructable and a changed skill
 * yields a different Execution rather than silently altering a replay, while the prompt still costs
 * only a listing line.
 */
export const skills = (pins: ReadonlyArray<SkillPin>): Pinned => {
  const entries = pins
    .map((skill) => {
      const payload = Schema.decodeSync(Schema.Json)(
        skill.importName === undefined
          ? { name: skill.name, digest: skill.digest }
          : { name: skill.name, digest: skill.digest, importName: skill.importName },
      )
      return {
        capability: {
          name: skill.name,
          pin: Pins.makeCapability({ codec: SKILL_CODEC, version: SKILL_VERSION, payload }),
        },
        payload,
      }
    })
    .toSorted((left, right) => (left.capability.name < right.capability.name ? -1 : 1))
  return {
    capabilities: entries.map((entry) => entry.capability),
    registrations: entries.map((entry) => ({
      pin: entry.capability.pin,
      codec: SKILL_CODEC,
      version: SKILL_VERSION,
      payload: entry.payload,
    })),
  }
}

/** The capability name the pinned harness snapshot is registered under on every Rika Agent. */
export const harnessCapabilityName = "rika-harness-snapshot"

/**
 * Pin one exact harness state as a manifest service capability plus its registration.
 *
 * The snapshot is pinned into the NEXT Execution: a refinement applied mid-Turn never rewrites the
 * running model's system prompt, and a reconstruction that decodes a different state fails
 * `SnapshotMismatch` rather than drifting.
 */
export const harness = (state: State.GuidanceState): Pinned => {
  const payload = Schema.decodeSync(Schema.Json)(Snapshot.encode(state))
  const capability = {
    name: harnessCapabilityName,
    pin: Pins.makeCapability({ codec: Snapshot.codec, version: Snapshot.version, payload }),
  }
  return {
    capabilities: [capability],
    registrations: [{ pin: capability.pin, codec: Snapshot.codec, version: Snapshot.version, payload }],
  }
}
