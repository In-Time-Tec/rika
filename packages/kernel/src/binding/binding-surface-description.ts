import type { HostBindingRegistry } from "@batonfx/repl"
import { maxSpawnedSubagentsPerExecution } from "@rika/product/subagent-policy"
import type { BindingRequirements } from "./binding-requirements"

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
    `You may spawn at most ${maxSpawnedSubagentsPerExecution} subagents across this execution tree; recursive Task delegation uses the same total.`,
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
    "rika.workspace.search returns { text, matches: [{ path, line, text }], matchesTruncation?: { kept, total },",
    "truncated }, where text is the bounded content-grep compatibility view; rika.workspace.list returns",
    "{ text, entries, truncated } for file and directory names. Search greps contents repo-wide; scope with",
    "path or use list for names.",
    "A page limit is bounded; a refused call names the bound and what it got, so read the message.",
    "A harness write takes baseSnapshot from (await rika.harness.snapshot({ scope })).snapshotId, read",
    "in the same cell. A stale one is refused, because it is what makes a concurrent write observable.",
    "",
    "// available on rika:",
    surfaceOf(facts.modules),
  ].join("\n")
