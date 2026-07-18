import { Ids, Workflow } from "@relayfx/sdk"
import { Schema } from "effect"

const Operation = Schema.Union([
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("sequence"), operations: Schema.Array(Schema.String) }),
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("child"), profile: Schema.String, prompt: Schema.String }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("tool"),
    toolName: Schema.String,
    input: Schema.optionalKey(Schema.Json),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("parallel"),
    fanOutKey: Schema.String,
    operations: Schema.Array(Schema.String),
    maxConcurrency: Schema.Int,
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("join"),
    parallelOperation: Schema.String,
    members: Schema.Array(Schema.String),
    policy: Schema.Union([
      Schema.TaggedStruct("all", {}),
      Schema.TaggedStruct("first-success", {}),
      Schema.TaggedStruct("quorum", { count: Schema.Int }),
      Schema.TaggedStruct("best-effort", {}),
    ]),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("branch"),
    condition: Schema.String,
    whenTrue: Schema.String,
    whenFalse: Schema.String,
  }),
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("approval"), prompt: Schema.String }),
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("timer"), durationMs: Schema.Int }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("retry"),
    operation: Schema.String,
    maxAttempts: Schema.Int,
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("budget"),
    operation: Schema.String,
    limit: Schema.Int,
    unit: Schema.Literals(["tokens", "milliseconds", "operations"]),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("cancellation"),
    operation: Schema.String,
    onCancel: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("compensation"),
    operation: Schema.String,
    compensateWith: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("structured-completion"),
    schemaRef: Schema.String,
    valueFrom: Schema.String,
  }),
])

export const DynamicDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  entry: Schema.String,
  operations: Schema.Array(Operation),
})
export type DynamicDefinition = typeof DynamicDefinition.Type

const operationId = (value: string) => Ids.WorkflowOperationId.make(value)
const workflowId = (value: string) => Ids.WorkflowDefinitionId.make(`rika:${value}:v1`)
const addressId = Ids.AddressId.make("address:rika")

export const compile = (input: DynamicDefinition): Workflow.RegisterDefinitionPayload => {
  const definition = Schema.decodeUnknownSync(DynamicDefinition)(input)
  const operations: Array<Workflow.OperationV2> = definition.operations.map((operation) => {
    const id = operationId(operation.id)
    switch (operation.kind) {
      case "sequence":
        return { id, kind: "sequence", operations: operation.operations.map(operationId) }
      case "child":
        return {
          id,
          kind: "child",
          address_id: addressId,
          preset_name: operation.profile,
          input: { prompt: operation.prompt },
        }
      case "tool":
        return {
          id,
          kind: "tool",
          tool_name: operation.toolName,
          ...(operation.input === undefined ? {} : { input: operation.input }),
        }
      case "parallel":
        return {
          id,
          kind: "parallel",
          fan_out_key: operation.fanOutKey,
          operations: operation.operations.map(operationId),
          max_concurrency: operation.maxConcurrency,
        }
      case "join":
        return {
          id,
          kind: "join",
          parallel_operation: operationId(operation.parallelOperation),
          members: operation.members.map(operationId),
          policy: operation.policy,
        }
      case "branch":
        return {
          id,
          kind: "branch",
          condition: operation.condition,
          when_true: operationId(operation.whenTrue),
          when_false: operationId(operation.whenFalse),
        }
      case "approval":
        return { id, kind: "approval", prompt: operation.prompt }
      case "timer":
        return { id, kind: "timer", duration_ms: operation.durationMs }
      case "retry":
        return { id, kind: "retry", operation: operationId(operation.operation), max_attempts: operation.maxAttempts }
      case "budget":
        return {
          id,
          kind: "budget",
          operation: operationId(operation.operation),
          limit: operation.limit,
          unit: operation.unit,
        }
      case "cancellation":
        return {
          id,
          kind: "cancellation",
          operation: operationId(operation.operation),
          ...(operation.onCancel === undefined ? {} : { on_cancel: operationId(operation.onCancel) }),
        }
      case "compensation":
        return {
          id,
          kind: "compensation",
          operation: operationId(operation.operation),
          compensate_with: operationId(operation.compensateWith),
        }
      case "structured-completion":
        return {
          id,
          kind: "structured-completion",
          schema_ref: operation.schemaRef,
          value_from: operationId(operation.valueFrom),
        }
    }
  })
  return Schema.decodeUnknownSync(Workflow.RegisterDefinitionPayload)({
    id: workflowId(definition.name),
    definition: {
      version: 2,
      name: definition.name,
      entry_operation_id: operationId(definition.entry),
      operations,
      metadata: { product: "rika", schema_version: definition.schemaVersion },
    },
  })
}

const child = (id: string, profile: string, prompt: string) => ({ id, kind: "child" as const, profile, prompt })
const delivery: DynamicDefinition = {
  schemaVersion: 1,
  name: "delivery",
  entry: "delivery:sequence",
  operations: [
    {
      id: "delivery:sequence",
      kind: "sequence",
      operations: ["delivery:investigate", "delivery:implement", "delivery:review", "delivery:fix", "delivery:verify"],
    },
    child("delivery:investigate", "Oracle", "Investigate the requested change and report grounded findings."),
    child("delivery:implement", "Task", "Implement the requested change from the investigation."),
    child("delivery:review", "Review", "Review the implementation for correctness and risks."),
    child("delivery:fix", "Task", "Fix all actionable review findings."),
    child("delivery:verify", "Task", "Run focused verification and report evidence."),
  ],
}
const research: DynamicDefinition = {
  schemaVersion: 1,
  name: "research-synthesis",
  entry: "research:sequence",
  operations: [
    {
      id: "research:sequence",
      kind: "sequence",
      operations: ["research:parallel", "research:join", "research:synthesis"],
    },
    {
      id: "research:parallel",
      kind: "parallel",
      fanOutKey: "research",
      operations: ["research:oracle", "research:librarian"],
      maxConcurrency: 2,
    },
    child("research:oracle", "Oracle", "Research the question from first principles and repository evidence."),
    child("research:librarian", "Librarian", "Research authoritative documentation and citations for the question."),
    {
      id: "research:join",
      kind: "join",
      parallelOperation: "research:parallel",
      members: ["research:oracle", "research:librarian"],
      policy: { _tag: "all" },
    },
    child("research:synthesis", "Task", "Synthesize the parallel research into one grounded answer."),
  ],
}

export const definitions: ReadonlyArray<Workflow.RegisterDefinitionPayload> = [compile(delivery), compile(research)]
export const idFor = workflowId
