import {
  AgentManifest,
  Pins,
  ProgramBindings,
  ProgramCapabilities,
  ProgramManifest,
  SandboxExecutor,
  ToolContext,
  ToolExecutor,
} from "@batonfx/core"
import { Errors, ExecutableResolver } from "@batonfx/runtime"
import { Effect, Schema } from "effect"
import { Response } from "effect/unstable/ai"
import { agentSelections, pins, schemas, toolkit } from "./baton-program"
import * as Sandbox from "./baton-sandbox-identity"
import * as Registration from "./baton-registration"

export class ProgramToolFailed extends Schema.TaggedErrorClass<ProgramToolFailed>()(
  "@rika/execution/ProgramToolFailed",
  { tool: Schema.String, message: Schema.String },
) {}

export interface ToolCall {
  readonly route: ToolExecutor.Route
  readonly context: ToolContext.Interface
  readonly sessionId: string
}

const replayPolicies: Readonly<Record<string, ProgramBindings.ProgramReplayPolicy>> = {
  bash: "non-idempotent",
  edit: "non-idempotent",
  grep: "idempotent",
  read: "idempotent",
  read_thread_transcript: "idempotent",
  read_web_page: "idempotent",
  search_threads: "idempotent",
  shell_command_status: "idempotent",
  view_media: "idempotent",
  web_search: "idempotent",
  write: "non-idempotent",
}

const replayPolicy = (name: string): ProgramBindings.ProgramReplayPolicy => {
  const policy = replayPolicies[name]
  if (policy === undefined) throw new TypeError(`Rika Program tool has no replay policy: ${name}`)
  return policy
}

const outcome = (name: string, result: ToolExecutor.Outcome): Effect.Effect<unknown, ProgramToolFailed> => {
  if (result._tag === "Success") return Effect.succeed(result.encodedResult)
  if (result._tag === "Suspend")
    return Effect.fail(ProgramToolFailed.make({ tool: name, message: `tool suspended on wait ${result.token}` }))
  return Effect.fail(ProgramToolFailed.make({ tool: name, message: JSON.stringify(result.encodedFailure) ?? "" }))
}

const callTool = (name: string, value: unknown, call: ToolCall): Effect.Effect<unknown, ProgramToolFailed> => {
  const part = Response.toolCallPart({ id: `program:${name}`, name, params: value, providerExecuted: false })
  return call.route
    .execute({
      call: part,
      toolCallBatch: { calls: [part] },
      turn: 0,
      toolCallIndex: 0,
      agentName: "rika-program",
      sessionId: call.sessionId,
    })
    .pipe(
      Effect.provideService(ToolContext.ToolContext, call.context),
      Effect.mapError((failure) => ProgramToolFailed.make({ tool: name, message: failure.message })),
      Effect.flatMap((result) => outcome(name, result)),
    )
}

const toolBinding = <I, IE, O, OE>(options: {
  readonly name: string
  readonly pin: AgentManifest.NamedCapability["pin"]
  readonly input: Schema.Codec<I, IE>
  readonly output: Schema.Codec<O, OE>
  readonly call: ToolCall
}): ProgramBindings.AnyTool =>
  ProgramBindings.tool({
    name: options.name,
    pin: options.pin,
    input: options.input,
    output: options.output,
    replay: replayPolicy(options.name),
    authorize: () => Effect.succeed(true),
    execute: (value: I) =>
      callTool(options.name, value, options.call).pipe(
        Effect.flatMap((encoded) =>
          Schema.decodeUnknownEffect(options.output)(encoded).pipe(
            Effect.mapError((cause) => ProgramToolFailed.make({ tool: options.name, message: String(cause) })),
          ),
        ),
      ),
  })

const agentBinding = (capability: ProgramManifest.ProgramAgentCapability): ProgramBindings.AnyAgent =>
  ProgramBindings.agent({
    selection: capability.selection,
    agent: capability.agent,
    inputPin: capability.input,
    input: schemas.agentInput,
    replay: "recorded",
    authorize: () => Effect.succeed(true),
    execute: () =>
      Effect.fail(ProgramCapabilities.ProgramSuspended.make({ operation: capability.selection, reason: "agent" })),
  })

const bind = <I, IE, O, OE>(
  tool: {
    readonly name: string
    readonly parametersSchema: Schema.Codec<I, IE>
    readonly successSchema: Schema.Codec<O, OE>
  },
  pin: AgentManifest.NamedCapability["pin"],
  call: ToolCall,
) => toolBinding({ name: tool.name, pin, input: tool.parametersSchema, output: tool.successSchema, call })

const boundTool = (name: string, pin: AgentManifest.NamedCapability["pin"], call: ToolCall) => {
  switch (name) {
    case "bash":
      return bind(toolkit.tools.bash, pin, call)
    case "edit":
      return bind(toolkit.tools.edit, pin, call)
    case "grep":
      return bind(toolkit.tools.grep, pin, call)
    case "read":
      return bind(toolkit.tools.read, pin, call)
    case "read_thread_transcript":
      return bind(toolkit.tools.read_thread_transcript, pin, call)
    case "read_web_page":
      return bind(toolkit.tools.read_web_page, pin, call)
    case "search_threads":
      return bind(toolkit.tools.search_threads, pin, call)
    case "shell_command_status":
      return bind(toolkit.tools.shell_command_status, pin, call)
    case "view_media":
      return bind(toolkit.tools.view_media, pin, call)
    case "web_search":
      return bind(toolkit.tools.web_search, pin, call)
    case "write":
      return bind(toolkit.tools.write, pin, call)
    default:
      return undefined
  }
}

export const reconstruction = (options: {
  readonly workspace: string
  readonly identity: Sandbox.Identity
  readonly call: ToolCall | undefined
  readonly sandbox: SandboxExecutor.Interface
}): ExecutableResolver.ProgramReconstruction => {
  const invalid = (message: string) => Errors.ExecutableRegistrationInvalid.make({ message })
  const live = new Map<string, (typeof toolkit.tools)[keyof typeof toolkit.tools]>(
    Object.values(toolkit.tools).map((value) => [value.name, value] as const),
  )
  const selections = new Set<string>(agentSelections)
  const admittedSchema = <Encoded>(
    definition: Registration.Codec<{ readonly schema: Schema.Json }, Encoded>,
    request: ExecutableResolver.CapabilityRequest,
    expected: Schema.Json,
    label: string,
  ) =>
    Registration.decode(definition, request.registration).pipe(
      Effect.flatMap((persisted) =>
        Pins.digest(persisted.schema) === Pins.digest(expected)
          ? Effect.void
          : invalid(`Program ${label} schema payload does not match the Rika executable: ${request.pin}`),
      ),
    )
  return {
    sandbox: (request) => {
      const admitted = Sandbox.payload(options.identity, options.workspace)
      if (request.pin !== pins.sandbox(options.identity, options.workspace))
        return invalid(`Program sandbox is not admitted by Rika: ${request.pin}`)
      return Registration.decode(Registration.codecs.programSandbox, request.registration).pipe(
        Effect.flatMap((persisted) =>
          Pins.digest(persisted) === Pins.digest(admitted)
            ? Effect.succeed(options.sandbox)
            : invalid(`Program sandbox identity does not match the running sandbox executor: ${request.pin}`),
        ),
      )
    },
    codec: (request) => {
      const expected = request.boundary === "input" ? pins.input : pins.output
      if (request.pin !== expected)
        return invalid(`Program ${request.boundary} schema is not admitted by Rika: ${request.pin}`)
      return admittedSchema(
        request.boundary === "input" ? Registration.codecs.programInput : Registration.codecs.programOutput,
        request,
        request.boundary === "input" ? schemas.inputDocument : schemas.outputDocument,
        request.boundary,
      ).pipe(Effect.as(request.boundary === "input" ? schemas.input : schemas.output))
    },
    tool: (request) => {
      const value = live.get(request.name)
      if (value === undefined || Registration.toolPin(value) !== request.pin)
        return invalid(`Program tool is not admitted by Rika: ${request.name}`)
      if (options.call === undefined) return invalid("Rika Program tools require workspace-scoped tool services")
      const binding = boundTool(request.name, request.pin, options.call)
      return binding === undefined
        ? invalid(`Rika Program tool is unavailable: ${request.name}`)
        : Effect.succeed(binding)
    },
    step: (request) => invalid(`Rika admits no Program steps: ${request.name}`),
    agent: (request) => {
      if (!selections.has(request.selection))
        return invalid(`Program Agent selection is not admitted by Rika: ${request.selection}`)
      if (request.pin !== pins.agentInput)
        return invalid(`Program Agent input schema is not admitted by Rika: ${request.pin}`)
      return admittedSchema(
        Registration.codecs.programAgentInput,
        request,
        schemas.agentInputDocument,
        "Agent input",
      ).pipe(Effect.as(agentBinding({ selection: request.selection, agent: request.agent, input: request.pin })))
    },
  }
}
