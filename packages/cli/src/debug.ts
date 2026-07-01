import { Telemetry } from "@rika/core"
import { Effect, Schema } from "effect"
import * as Args from "./args"
import { launchMotel as launchMotelProcess } from "./motel-runner.js"

export class DebugError extends Schema.TaggedErrorClass<DebugError>()("DebugError", {
  message: Schema.String,
}) {}

export type RunError = DebugError

export const executeCommand = Effect.fn("Cli.Debug.executeCommand")(function* (
  command: Args.DebugCommand,
  env: Record<string, string | undefined>,
) {
  if (command.all === (command.thread_id !== undefined)) {
    return yield* Effect.fail(new DebugError({ message: "Expected exactly one of --all or --thread <thread-id>" }))
  }

  const endpoint = trimTrailingSlash(env.RIKA_TELEMETRY_ENDPOINT ?? Telemetry.defaultEndpoint)
  yield* launchMotel({
    MOTEL_OTEL_BASE_URL: endpoint,
    MOTEL_OTEL_QUERY_URL: endpoint,
    MOTEL_TUI_SERVICE_NAME: Telemetry.serviceName,
    MOTEL_TUI_ATTR_KEY: command.thread_id === undefined ? undefined : "rika.thread_id",
    MOTEL_TUI_ATTR_VALUE: command.thread_id,
  })
  return 0
})

export const formatError = (error: RunError) => {
  if (error instanceof DebugError) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const launchMotel = (env: Record<string, string | undefined>) =>
  Effect.tryPromise({
    try: () => launchMotelProcess([process.argv[0] ?? "bun", "motel", "tui"], env),
    catch: (error) => new DebugError({ message: error instanceof Error ? error.message : String(error) }),
  })

const trimTrailingSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value)
