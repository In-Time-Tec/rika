import { KernelProfile, type HostBindingRegistry } from "@batonfx/repl"
import type { BindingRequirements, Options } from "./binding-requirements"
import * as AgentsBinding from "./agents-binding"
import * as ArtifactsBinding from "./artifacts-binding"
import * as ContextBinding from "./context-binding"
import * as EditsBinding from "./edits-binding"
import * as GoalBinding from "./goal-binding"
import * as HarnessBinding from "./harness-binding"
import * as McpBinding from "./mcp-binding"
import * as MediaBinding from "./media-binding"
import * as ProcessesBinding from "./processes-binding"
import * as ThreadsBinding from "./threads-binding"
import * as WebBinding from "./web-binding"
import * as WorkspaceBinding from "./workspace-binding"
import { source } from "../kernel-bootstrap"

export type { BindingRequirements, Options } from "./binding-requirements"

/**
 * The mounted surface, in the order the bootstrap cell assembles it. Every name here becomes a
 * kernel global, so adding, removing, or renaming one changes `bindingsDigest` and starts a new
 * kernel epoch.
 */
export const make = (options: Options): ReadonlyArray<HostBindingRegistry.Module<BindingRequirements>> => [
  WorkspaceBinding.module,
  EditsBinding.module,
  ProcessesBinding.module,
  WebBinding.module,
  MediaBinding.module,
  ThreadsBinding.make(options.workspace),
  AgentsBinding.module,
  ContextBinding.make({ workspace: options.workspace, trustMode: options.trustMode }),
  HarnessBinding.make({ workspaceDigest: options.workspaceDigest }),
  GoalBinding.module,
  McpBinding.make(options.servers),
  ArtifactsBinding.module,
]

/**
 * What a cell can reach, in the words a model needs to reach it. The mounted modules answer this
 * themselves, so a binding that is added, removed, or renamed cannot drift from what a model is told
 * it has — and a surface nothing describes is one a model will decline to use.
 */
const shapeOf = (fields: Record<string, unknown> | undefined): string => {
  if (fields === undefined) return "…"
  /**
   * A union member is told apart by its tag, and a tag carries one `literal` rather than a list of
   * them. Naming the fields alone leaves a model shown several alternatives with nothing to choose
   * between them, which is how one call gets guessed six ways.
   */
  const named = Object.entries(fields).map(([name, value]) => {
    const holder = value as { readonly literal?: unknown; readonly schema?: { readonly literal?: unknown } }
    const literal = holder.literal ?? holder.schema?.literal
    return literal === undefined ? name : `${name}: ${JSON.stringify(literal)}`
  })
  return `{ ${named.join(", ")} }`
}

export const surfaceOf = (modules: ReadonlyArray<HostBindingRegistry.Module<BindingRequirements>>): string =>
  modules
    .map((module) => {
      const operations = module.operations
        .map((operation) => {
          type Literal = {
            readonly literals?: ReadonlyArray<unknown>
            readonly literal?: unknown
            readonly schema?: Literal
            readonly members?: ReadonlyArray<Literal>
            readonly fields?: Record<string, Literal>
          }
          /**
           * Every operation takes a struct, and one that does not cannot be described field by
           * field. Defaulting to none would tell a model the operation takes no argument, so this
           * refuses rather than describing a surface that is not there.
           */
          const shape = (operation.input as unknown as { readonly fields?: Record<string, Literal> }).fields
          if (shape === undefined)
            throw new Error(`rika.${module.name}.${operation.name} has an input that is not a struct`)
          const fields = Object.entries(shape).map(([field, value]) => {
            // An optional field wraps the schema it makes optional, so the allowed values sit one
            // level in. Naming them matters more than naming the field: a model that invents one
            // spends a turn discovering the field would only ever have taken a few.
            /**
             * A discriminating tag carries one `literal`, not a `literals` list, and it is the only
             * thing that tells one member of a union from another. Reading only the list left a
             * model shown four alternatives with nothing to choose between them.
             */
            const tag = value.literal ?? value.schema?.literal
            const literals = value.literals ?? value.schema?.literals ?? (tag === undefined ? undefined : [tag])
            // A literal is written the way a cell writes it, so a number stays a number rather than
            // arriving quoted and being sent as a string.
            if (literals !== undefined) return `${field}: ${literals.map((one) => JSON.stringify(one)).join("|")}`
            // A field whose value is one of several shapes is named by those shapes, because a model
            // told only the field name reads it as "any value" and writes a string.
            const members = value.members ?? value.schema?.members
            if (members === undefined) return field
            return `${field}: ${members.map((member) => shapeOf(member.fields ?? member.schema?.fields)).join("|")}`
          })
          return `${operation.name}(${fields.length === 0 ? "" : `{ ${fields.join(", ")} }`})`
        })
        .join(", ")
      return `//   rika.${module.name} -> ${operations}`
    })
    .join("\n")

export const moduleNames: ReadonlyArray<string> = [
  WorkspaceBinding.name,
  EditsBinding.name,
  ProcessesBinding.name,
  WebBinding.name,
  MediaBinding.name,
  ThreadsBinding.name,
  AgentsBinding.name,
  ContextBinding.name,
  HarnessBinding.name,
  GoalBinding.name,
  McpBinding.name,
  ArtifactsBinding.name,
]

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

/**
 * What a model is told about its one tool. The list of bindings reads as code beside an example
 * rather than a catalogue, because a model shown a bare list of module names answers with one of
 * them as a tool name — and the only tool that exists is the cell.
 */
const bytes = (value: number): string => (value % 1_024 === 0 ? `${value / 1_024}KB` : `${value} bytes`)

export interface CellInstructionFacts {
  readonly modules: ReadonlyArray<HostBindingRegistry.Module<BindingRequirements>>
  readonly workspace: string
  readonly workspaceState?: "empty" | "not empty"
  readonly channelBytes: number
  readonly cellDeadlineMillis: number
}

export const cellInstructions = (facts: CellInstructionFacts): string =>
  [
    "You have exactly one tool, named typescript. It runs a cell in a persistent Bun kernel.",
    `A cell is stopped after ${facts.cellDeadlineMillis / 1_000}s. Long work belongs in a subagent, not a cell that sleeps.`,
    "`rika` and its modules are pre-mounted globals; never import them.",
    "Variables persist across all your cells; accumulate state instead of re-fetching it.",
    facts.workspaceState === undefined
      ? `Your workspace is ${JSON.stringify(facts.workspace)}.`
      : `Your workspace is ${JSON.stringify(facts.workspace)} and it is ${facts.workspaceState}.`,
    `Cell stdout and stderr are each capped at ${bytes(facts.channelBytes)}; page big results at 16KB per page.`,
    "Run shell commands with rika.processes.start; it is the supported shell path.",
    "After spawning children, end your turn or keep working; bounded settlements are delivered durably at a",
    "model-turn boundary or the next same-Thread turn. rika.agents.inbox pages structured settlements by afterSequence.",
    "Do not poll or sleep.",
    "The kernel exposes a `rika` object your cell code can await. It is not a tool; the only tool",
    "name that exists is typescript. Example cell body:",
    "",
    '  const found = await rika.workspace.search({ pattern: "secret" })',
    '  found.text.split("\\n").length',
    "",
    "The value of a cell's last expression comes back to you. Printing costs a separate channel and",
    "is truncated, so end a cell with what you want to read.",
    "",
    "Workspace results have exact shapes: (await rika.workspace.read({ path })).text is file content;",
    "rika.workspace.search returns { text, matches: [{ path, line, text }], truncated }, where text is the bounded",
    "content-grep compatibility view; rika.workspace.list returns { text, entries, truncated } for file and",
    "directory names. Search greps contents repo-wide; scope with path or use list for names.",
    "A page limit is bounded; a refused call names the bound and what it got, so read the message.",
    "A harness write takes baseSnapshot from (await rika.harness.snapshot({ scope })).snapshotId, read",
    "in the same cell. A stale one is refused, because it is what makes a concurrent write observable.",
    "",
    "// available on rika:",
    surfaceOf(facts.modules),
  ].join("\n")
