import { AgentManifest, Pins, ProgramManifest } from "@batonfx/core"
import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"
import { Schema, SchemaRepresentation, SchemaTransformation } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Sandbox from "./baton-sandbox-identity"

export const budget: ProgramManifest.ProgramBudget = {
  agentRuns: 16,
  concurrency: 4,
  toolCalls: 256,
  tokens: 2_000_000,
  wallClockMillis: 600_000,
  logBytes: 65_536,
  outputBytes: 262_144,
}

export const maxSourceBytes = 65_536

const instruction = Schema.Struct({ instruction: Schema.String })

const userText = (content: Prompt.UserMessageEncoded["content"]): ReadonlyArray<string> =>
  typeof content === "string" ? [content] : content.flatMap((part) => (part.type === "text" ? [part.text] : []))

const instructionText = (encoded: Prompt.PromptEncoded): string =>
  encoded.content.flatMap((message) => (message.role === "user" ? userText(message.content) : [])).join("\n")

const input: Schema.Codec<Prompt.Prompt, typeof instruction.Encoded> = instruction.pipe(
  Schema.decodeTo(
    Prompt.Prompt,
    SchemaTransformation.transform({
      decode: (value: typeof instruction.Type): Prompt.PromptEncoded => ({
        content: [{ role: "user", content: [{ type: "text", text: value.instruction }] }],
      }),
      encode: (value: Prompt.PromptEncoded) => ({ instruction: instructionText(value) }),
    }),
  ),
)

const output = Schema.Struct({ summary: Schema.String, data: Schema.optionalKey(Schema.Json) })

const agentInput = Schema.String

const document = (schema: Schema.Top): Schema.Json =>
  Schema.encodeSync(SchemaRepresentation.DocumentFromJson)(SchemaRepresentation.fromAST(schema.ast))

export const schemas = {
  input,
  output,
  agentInput,
  inputDocument: document(input),
  outputDocument: document(output),
  agentInputDocument: document(agentInput),
}

export const pins = {
  sandbox: (identity: Sandbox.Identity, workspace: string) =>
    Pins.makeCapability({
      contract: "rika-program-sandbox",
      version: 1,
      sandbox: Sandbox.payload(identity, workspace),
    }),
  input: Pins.makeCapability({ contract: "rika-program-input", version: 1, schema: schemas.inputDocument }),
  output: Pins.makeCapability({ contract: "rika-program-output", version: 1, schema: schemas.outputDocument }),
  agentInput: Pins.makeCapability({
    contract: "rika-program-agent-input",
    version: 1,
    schema: schemas.agentInputDocument,
  }),
}

export const toolkit = RoleToolkits.root

export const agentSelections = ["Oracle", "Librarian", "Painter", "ReadThread", "Surgeon", "Task"] as const

const compare = (left: string, right: string): number => (left < right ? -1 : Number(left > right))

const byText = <A>(values: ReadonlyArray<A>, orderOf: (value: A) => string): Array<A> =>
  [...values].toSorted((left, right) => compare(orderOf(left), orderOf(right)))

export const authority = (options: {
  readonly workspace: string
  readonly sandbox: Sandbox.Identity
  readonly tools: ReadonlyArray<AgentManifest.NamedCapability>
  readonly agents: ReadonlyArray<{ readonly selection: string; readonly agent: AgentManifest.ChildBinding["agent"] }>
}): AgentManifest.ProgramAuthority => ({
  sandbox: pins.sandbox(options.sandbox, options.workspace),
  input: pins.input,
  output: pins.output,
  maxSourceBytes,
  tools: byText(options.tools, ({ name }) => name),
  agents: byText(
    options.agents.map(({ selection, agent }) => ({ selection, agent, input: pins.agentInput })),
    ({ selection }) => selection,
  ),
  steps: [],
  budget,
})
