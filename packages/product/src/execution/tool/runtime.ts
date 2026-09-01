import { Context, Effect, Layer, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import * as Bash from "./bash"
import * as Edit from "./edit"
import * as Read from "./read"
import * as ShellCommandStatus from "./shell-command-status"
import * as NativeToolResult from "./result"

/** Private compatibility request used by recorded `!` shell turns. It is not model-facing or catalogued. */
export const RecordedShellRequest = Schema.Struct({
  _tag: Schema.tag("Shell"),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  waitMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type RecordedShellRequest = typeof RecordedShellRequest.Type

export const Request = Schema.Union([
  Bash.Request,
  ShellCommandStatus.Request,
  Read.Request,
  Edit.Request,
  RecordedShellRequest,
])
export type Request = typeof Request.Type
export type Result = NativeToolResult.Result

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  category: NativeToolResult.FailureCategory,
  outcome: Schema.Literals(["known", "unknown"]),
  recovery: NativeToolResult.Recovery,
  nextAction: Schema.String,
}) {}

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, ToolError>
}

/** Executor-owned implementations provide this product port. */
export class Service extends Context.Service<Service, Interface>()("@rika/product/execution/tool/runtime/Service") {}

export const registrations = [
  Bash.registration,
  ShellCommandStatus.registration,
  Read.registration,
  Edit.registration,
] as const

export const toolkit = Toolkit.make(Bash.tool, ShellCommandStatus.tool, Read.tool, Edit.tool)

export const testLayer = (run: Interface["run"]) => Layer.succeed(Service, Service.of({ run }))
