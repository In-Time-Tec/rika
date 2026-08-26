import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as Bash from "@rika/coding-tools/bash-tool"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ShellCommandStatus from "@rika/coding-tools/shell-command-status-tool"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import { nested, NestedOperationFailed, operation, type Requirements } from "../envelope"

export const name = "processes"

const Failure = Schema.Union([CodingToolResult.ToolFailure, NestedOperationFailed])

const InitialWaitMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Bash.initialWaitMaximumMillis),
)
const StatusWaitMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(ShellCommandStatus.statusWaitMaximumMillis),
)

const Output = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
})

const Stopped = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })

const StartInput = Schema.Struct({
  command: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  timeoutMillis: Schema.optionalKey(InitialWaitMillis),
})
const StatusInput = Schema.Struct({ processId: Schema.String, waitMillis: Schema.optionalKey(StatusWaitMillis) })
const StopInput = Schema.Struct({ processId: Schema.String })

const run = (request: typeof CodingToolRuntime.Request.Type) =>
  Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request))

const output = (result: CodingToolResult.Result) => {
  let value: typeof Output.Type = {
    text: result.text,
    truncated: result.truncated,
  }
  if (result.running !== undefined) value = { ...value, running: result.running }
  if (result.processId !== undefined) value = { ...value, processId: result.processId }
  if (result.exitCode !== undefined) value = { ...value, exitCode: result.exitCode }
  if (result.stdout !== undefined) value = { ...value, stdout: result.stdout }
  if (result.stderr !== undefined) value = { ...value, stderr: result.stderr }
  return value
}

const startRequest = (input: typeof StartInput.Type): typeof CodingToolRuntime.Request.Type => {
  let request: typeof CodingToolRuntime.Request.Type = { _tag: "Bash", command: input.command }
  if (input.workdir !== undefined) request = { ...request, workdir: input.workdir }
  if (input.timeoutMillis !== undefined) request = { ...request, timeoutMillis: input.timeoutMillis }
  return request
}

const statusRequest = (input: typeof StatusInput.Type): typeof CodingToolRuntime.Request.Type =>
  input.waitMillis === undefined
    ? { _tag: "ShellCommandStatus", processId: input.processId }
    : { _tag: "ShellCommandStatus", processId: input.processId, waitMillis: input.waitMillis }

const stopFailure = (processId: string) =>
  CodingToolRuntime.ToolError.make({
    tool: "process_stop",
    message: `No running process is registered under id ${processId}. The call did not change state.`,
    kind: "operation",
    category: "not_found",
    outcome: "known",
    recovery: "after_change",
    nextAction: "List running processes and stop one that exists",
  })

export const operations: ReadonlyArray<
  HostBindingRegistry.AnyOperation<CodingToolRuntime.Service | ShellProcessRegistry.Service | Requirements>
> = [
  operation({
    name: "start",
    input: StartInput,
    output: Output,
    failure: Failure,
    handle: (input) =>
      nested(
        {
          kind: "process.start",
          payload: input,
          replayPolicy: "never",
          approval: { capability: "process.start", request: { command: input.command } },
        },
        Effect.map(run(startRequest(input)), output),
      ),
  }),
  operation({
    name: "status",
    input: StatusInput,
    output: Output,
    failure: Failure,
    handle: (input) => Effect.map(run(statusRequest(input)), output),
  }),
  operation({
    name: "stop",
    input: StopInput,
    output: Stopped,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "process.stop", payload: input, replayPolicy: "never" },
        Effect.flatMap(ShellProcessRegistry.Service, (registry) =>
          registry.cancel(input.processId).pipe(
            Effect.mapError(() => stopFailure(input.processId)),
            Effect.as({ text: `Stopped process ${input.processId}`, truncated: false }),
          ),
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<
  CodingToolRuntime.Service | ShellProcessRegistry.Service | Requirements
> = { name, operations }
