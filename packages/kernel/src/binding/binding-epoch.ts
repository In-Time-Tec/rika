import { KernelProfile } from "@batonfx/repl"
import { source } from "../kernel-bootstrap"
import { moduleNames } from "./binding-module-catalog"

/**
 * What a cell can import or reach that is not part of the mounted surface itself. An untrusted
 * executable skill is deliberately absent: it is listed to the model but never importable, so it is
 * not part of the environment the epoch is reconstructed from.
 */
export interface Environment {
  readonly skills?: ReadonlyArray<{
    readonly name: string
    readonly importName: string
    readonly digest: string
    readonly importable: boolean
  }>
  readonly servers?: ReadonlyArray<{ readonly server: { readonly name: string }; readonly enabled: boolean }>
}

const environmentEntries = (environment: Environment | undefined): ReadonlyArray<string> => {
  if (environment === undefined) return []
  const skills = (environment.skills ?? [])
    .filter((skill) => skill.importable)
    .map((skill) => `skill:${skill.name}:${skill.importName}:${skill.digest}`)
    .toSorted()
  const servers = (environment.servers ?? [])
    .filter((entry) => entry.enabled)
    .map((entry) => `mcp:${entry.server.name}`)
    .toSorted()
  return [...skills, ...servers]
}

/**
 * The kernel epoch identity of this exact surface, including how the bootstrap assembles it and
 * what the environment makes importable or reachable. Changing the executable skill set or the
 * reachable MCP servers changes the digest and therefore starts a new epoch.
 */
export const bindingsDigest = (environment?: Environment): string =>
  KernelProfile.bindingsDigest([...moduleNames, `bootstrap:${source(moduleNames)}`, ...environmentEntries(environment)])
