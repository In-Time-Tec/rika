import { Option, Schema, SchemaAST } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import type { BindingRequirements } from "./requirements"

/**
 * What a cell can reach, in the words a model needs to reach it. The mounted modules answer this
 * themselves, so a binding that is added, removed, or renamed cannot drift from what a model is told
 * it has — and a surface nothing describes is one a model will decline to use.
 */
/**
 * The bound a field actually enforces, in the words a caller writes it.
 *
 * A schema carries its constraints as checks on its AST, but the surface named only the field, so a
 * model had to guess the shape and learn the bound from a refusal. Every guess cost a turn, and the
 * refusals were identical in kind: `range` sent as `{ start, end }` when it is a two-element array,
 * `depth` sent as 10 against a maximum of 8, `limit` sent as 50 against 20.
 */
const BoundRepresentation = Schema.Struct({
  id: Schema.String,
  payload: Schema.NullOr(
    Schema.Struct({
      exclusiveMinimum: Schema.optionalKey(Schema.Finite),
      minimum: Schema.optionalKey(Schema.Finite),
      exclusiveMaximum: Schema.optionalKey(Schema.Finite),
      maximum: Schema.optionalKey(Schema.Finite),
    }),
  ),
})

const boundsOf = (ast: SchemaAST.AST): string | undefined => {
  let minimum: number | undefined
  let maximum: number | undefined
  let length: number | undefined
  for (const check of ast.checks ?? []) {
    const decoded = Schema.decodeUnknownOption(BoundRepresentation)(check.annotations?.representation)
    if (Option.isNone(decoded) || decoded.value.payload === null) continue
    const { id: tag, payload } = decoded.value
    if (tag === "effect/schema/isGreaterThan" && payload.exclusiveMinimum !== undefined)
      minimum = payload.exclusiveMinimum + 1
    if (tag === "effect/schema/isGreaterThanOrEqualTo" && payload.minimum !== undefined) minimum = payload.minimum
    if (tag === "effect/schema/isLessThan" && payload.exclusiveMaximum !== undefined)
      maximum = payload.exclusiveMaximum - 1
    if (tag === "effect/schema/isLessThanOrEqualTo" && payload.maximum !== undefined) maximum = payload.maximum
    if (
      tag === "effect/schema/isLengthBetween" &&
      payload.minimum === payload.maximum &&
      payload.minimum !== undefined
    )
      length = payload.minimum
  }
  if (ast._tag === "Arrays")
    return length === undefined
      ? "[]"
      : `[${Array.from({ length }, (_, index) => (index === 0 ? "start" : "end")).join(", ")}]`
  if (minimum !== undefined && maximum !== undefined) return `${minimum}-${maximum}`
  if (maximum !== undefined) return `<=${maximum}`
  if (minimum !== undefined) return `>=${minimum}`
  return undefined
}

const objectFields = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.PropertySignature> | undefined =>
  ast._tag === "Objects" ? ast.propertySignatures : undefined

const literalOf = (ast: SchemaAST.AST): SchemaAST.LiteralValue | undefined => {
  if (ast._tag === "Literal") return ast.literal
  if (ast._tag === "Union") {
    const literal = ast.types.find((member) => member._tag === "Literal")
    return literal?._tag === "Literal" ? literal.literal : undefined
  }
  return undefined
}

const objectDescription = (fields: ReadonlyArray<SchemaAST.PropertySignature> | undefined): string => {
  if (fields === undefined) return "…"
  /**
   * A union member is told apart by its tag, and a tag carries one `literal` rather than a list of
   * them. Naming the fields alone leaves a model shown several alternatives with nothing to choose
   * between them, which is how one call gets guessed six ways.
   */
  const named = fields.map((field) => {
    const name = String(field.name)
    const literal = literalOf(field.type)
    return literal === undefined ? name : `${name}: ${JSON.stringify(literal)}`
  })
  return `{ ${named.join(", ")} }`
}

export const surfaceOf = (modules: ReadonlyArray<HostBindingRegistry.Module<BindingRequirements>>): string =>
  modules
    .map((module) => {
      const operations = module.operations
        .map((operation) => {
          /**
           * Every operation takes a struct, and one that does not cannot be described field by
           * field. Defaulting to none would tell a model the operation takes no argument, so this
           * refuses rather than describing a surface that is not there.
           */
          const inputFields = objectFields(operation.input.ast)
          if (inputFields === undefined)
            throw new Error(`rika.${module.name}.${operation.name} has an input that is not a struct`)
          const fields = inputFields.map((inputField) => {
            const field = String(inputField.name)
            const value = inputField.type
            // An optional field wraps the schema it makes optional, so the allowed values sit one
            // level in. Naming them matters more than naming the field: a model that invents one
            // spends a turn discovering the field would only ever have taken a few.
            /**
             * A discriminating tag carries one `literal`, not a `literals` list, and it is the only
             * thing that tells one member of a union from another. Reading only the list left a
             * model shown four alternatives with nothing to choose between them.
             */
            const members = value._tag === "Union" ? value.types.filter((member) => member._tag !== "Undefined") : [value]
            const literals = members.flatMap((member) => (member._tag === "Literal" ? [member.literal] : []))
            // A literal is written the way a cell writes it, so a number stays a number rather than
            // arriving quoted and being sent as a string.
            if (literals.length > 0) return `${field}: ${literals.map((one) => JSON.stringify(one)).join("|")}`
            // A field whose value is one of several shapes is named by those shapes, because a model
            // told only the field name reads it as "any value" and writes a string.
            const alternatives = members.map(objectFields).filter((candidate) => candidate !== undefined)
            if (alternatives.length === 0) {
              const bounds = boundsOf(members[0] ?? value)
              return bounds === undefined ? field : `${field}: ${bounds}`
            }
            return `${field}: ${alternatives.map(objectDescription).join("|")}`
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
    "A relative path resolves from your workspace, and an absolute path is read and written as given,",
    "so a sibling repository is reachable through the same workspace tools rather than through the shell.",
    `Cell stdout and stderr are each capped at ${bytes(facts.channelBytes)}, so read a result whole rather than piping it through head or tail and paying a second cell to see the rest.`,
    "Run shell commands with rika.processes.start; it is the supported shell path.",
    "Wait for one with rika.processes.status({ processId, waitMillis }), which returns as soon as the",
    "process settles. Sleeping inside a cell spends the cell's own deadline on waiting instead.",
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
