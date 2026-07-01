import { Telemetry } from "@rika/core"
import { Effect, Schema } from "effect"
import * as Args from "./args"
import { launchInspect as launchInspectProcess } from "./inspect-runner.js"

export class InspectError extends Schema.TaggedErrorClass<InspectError>()("InspectError", {
  message: Schema.String,
}) {}

export type RunError = InspectError

export const executeCommand = Effect.fn("Cli.Inspect.executeCommand")(function* (
  command: Args.InspectCommand,
  env: Record<string, string | undefined>,
) {
  if (command.all === (command.thread_id !== undefined)) {
    return yield* Effect.fail(new InspectError({ message: "Expected exactly one of --all or --thread <thread-id>" }))
  }

  const endpoint = trimTrailingSlash(env.RIKA_TELEMETRY_ENDPOINT ?? Telemetry.defaultEndpoint)
  yield* launchInspect({
    ...env,
    MOTEL_OTEL_BASE_URL: endpoint,
    MOTEL_OTEL_QUERY_URL: endpoint,
    MOTEL_TUI_SERVICE_NAME: Telemetry.serviceName,
    MOTEL_TUI_ATTR_KEY: command.thread_id === undefined ? undefined : "rika.thread_id",
    MOTEL_TUI_ATTR_VALUE: command.thread_id,
    MOTEL_TUI_THEME: env.MOTEL_TUI_THEME ?? "rika",
  })
  return 0
})

export const formatError = (error: RunError) => {
  if (error instanceof InspectError) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const launchInspect = (env: Record<string, string | undefined>) =>
  Effect.tryPromise({
    try: () => launchInspectProcess(["tui"], env),
    catch: (error) => new InspectError({ message: error instanceof Error ? error.message : String(error) }),
  })

const trimTrailingSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value)
