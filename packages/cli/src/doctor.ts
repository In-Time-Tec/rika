import { PermissionPolicy } from "@rika/agent"
import { Telemetry } from "@rika/core"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as LocalBackend from "./local-backend"
import * as Output from "./output"

export interface EnvironmentSummary extends Schema.Schema.Type<typeof EnvironmentSummary> {}
export const EnvironmentSummary = Schema.Struct({
  bun_version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  cwd: Schema.String,
  ci: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Doctor.EnvironmentSummary" })

export interface ConfigSummary extends Schema.Schema.Type<typeof ConfigSummary> {}
export const ConfigSummary = Schema.Struct({
  workspace_root: Schema.String,
  data_dir: Schema.String,
  database_url_configured: Schema.Boolean,
  base_url_configured: Schema.Boolean,
  api_key_configured: Schema.Boolean,
  embeddings_api_key_configured: Schema.Boolean,
  telemetry: Schema.Literals(["disabled", "enabled"]),
  telemetry_endpoint: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Doctor.ConfigSummary" })

export interface RivetSummary extends Schema.Schema.Type<typeof RivetSummary> {}
export const RivetSummary = Schema.Struct({
  host: Schema.String,
  endpoint: Schema.String,
  token_configured: Schema.Boolean,
  namespace_configured: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Doctor.RivetSummary" })

export interface BackendSummary extends Schema.Schema.Type<typeof BackendSummary> {}
export const BackendSummary = Schema.Struct({
  status: Schema.String,
  endpoint: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Cli.Doctor.BackendSummary" })

export const CheckStatus = Schema.Literals(["ok", "warning"])
export type CheckStatus = typeof CheckStatus.Type

export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  name: Schema.String,
  status: CheckStatus,
  message: Schema.String,
}).annotate({ identifier: "Rika.Cli.Doctor.Check" })

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  version: Schema.String,
  environment: EnvironmentSummary,
  config: ConfigSummary,
  backend: BackendSummary,
  permission: PermissionPolicy.PermissionSummary,
  rivet: RivetSummary,
  checks: Schema.Array(Check),
}).annotate({ identifier: "Rika.Cli.Doctor.Report" })

export interface Input {
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly version?: string
}

export class DoctorError extends Schema.TaggedErrorClass<DoctorError>()("DoctorError", {
  message: Schema.String,
}) {}

export type RunError = DoctorError

export interface Interface {
  readonly executeCommand: (command: Args.DoctorCommand) => Effect.Effect<number, RunError>
  readonly report: Effect.Effect<Report, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Doctor") {}

export const layerFromInput = (input: Input) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const output = yield* Output.Service
      const backend = yield* LocalBackend.Service
      const makeReport = reportFromInput(input, backend)

      return Service.of({
        executeCommand: Effect.fn("Cli.Doctor.executeCommand")(function* (_command: Args.DoctorCommand) {
          const report = yield* makeReport
          yield* output.stdout(JSON.stringify(report))
          return 0
        }),
        report: makeReport,
      })
    }),
  )

export const executeCommand = Effect.fn("Cli.Doctor.executeCommand.call")(function* (command: Args.DoctorCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const report = Effect.fn("Cli.Doctor.report.call")(function* () {
  const service = yield* Service
  return yield* service.report
})

export const formatError = (error: RunError) => `Rika failed: ${error.message}`

const reportFromInput = (input: Input, backend: LocalBackend.Interface): Effect.Effect<Report, DoctorError> =>
  Effect.gen(function* () {
    const workspaceRoot = input.env.RIKA_WORKSPACE_ROOT ?? input.cwd
    const dataDir = input.env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
    const rivetHost = input.env.RIKA_RIVET_HOST ?? "local"
    const rivetEndpoint = input.env.RIKA_RIVET_ENDPOINT ?? input.env.RIVET_ENDPOINT ?? "http://127.0.0.1:6420"
    const apiKeyConfigured = secretConfigured(input.env.RIKA_API_KEY)
    const embeddingsApiKeyConfigured = secretConfigured(input.env.RIKA_EMBEDDINGS_API_KEY)
    const telemetry = Telemetry.fromEnv(input.env, input.version ?? "0.0.0")
    const permissionConfig = PermissionPolicy.configFromEnv(input.env)
    const permissionSummary = PermissionPolicy.summary(permissionConfig)
    const backendStatus = yield* backend
      .status({ workspace_root: workspaceRoot, data_dir: dataDir })
      .pipe(Effect.mapError((error) => new DoctorError({ message: error.message })))
    const diagnosticReport: Report = {
      version: input.version ?? "0.0.0",
      environment: {
        bun_version: Bun.version,
        platform: process.platform,
        arch: process.arch,
        cwd: input.cwd,
        ci: input.env.CI === "true" || input.env.CI === "1",
      },
      config: {
        workspace_root: workspaceRoot,
        data_dir: dataDir,
        database_url_configured: input.env.RIKA_DATABASE_URL !== undefined,
        base_url_configured: input.env.RIKA_BASE_URL !== undefined,
        api_key_configured: apiKeyConfigured,
        embeddings_api_key_configured: embeddingsApiKeyConfigured,
        telemetry: telemetry.enabled ? "enabled" : "disabled",
        ...(telemetry.enabled ? { telemetry_endpoint: telemetry.endpoint } : {}),
      },
      backend: {
        status: backendStatus.status,
        ...(backendStatus.endpoint === undefined ? {} : { endpoint: backendStatus.endpoint }),
        ...(backendStatus.pid === undefined || backendStatus.pid === 0 ? {} : { pid: backendStatus.pid }),
      },
      permission: permissionSummary,
      rivet: {
        host: rivetHost,
        endpoint: rivetEndpoint,
        token_configured: secretConfigured(input.env.RIKA_RIVET_TOKEN) || secretConfigured(input.env.RIVET_TOKEN),
        namespace_configured: input.env.RIKA_RIVET_NAMESPACE !== undefined || input.env.RIVET_NAMESPACE !== undefined,
      },
      checks: checks({
        dataDir,
        apiKeyConfigured,
        embeddingsApiKeyConfigured,
        permissionSummary,
        rivetHost,
        rivetEndpoint,
        telemetry,
      }),
    }
    return diagnosticReport
  })

const checks = (input: {
  readonly dataDir: string
  readonly apiKeyConfigured: boolean
  readonly embeddingsApiKeyConfigured: boolean
  readonly permissionSummary: PermissionPolicy.PermissionSummary
  readonly rivetHost: string
  readonly rivetEndpoint: string
  readonly telemetry: Telemetry.Options
}): ReadonlyArray<Check> => [
  {
    name: "data-dir",
    status: input.dataDir.length > 0 ? "ok" : "warning",
    message: input.dataDir.length > 0 ? "Data directory is configured." : "Data directory is empty.",
  },
  {
    name: "model-provider",
    status: input.apiKeyConfigured ? "ok" : "warning",
    message: input.apiKeyConfigured
      ? "Model provider API key is configured. Secret values are not printed."
      : "RIKA_API_KEY is required for live model calls.",
  },
  {
    name: "embeddings-provider",
    status: input.embeddingsApiKeyConfigured || input.apiKeyConfigured ? "ok" : "warning",
    message: input.embeddingsApiKeyConfigured
      ? "Thread memory embedding API key is configured. Secret values are not printed."
      : input.apiKeyConfigured
        ? "Thread memory embeddings will use the OpenAI model key fallback when OpenAI is configured."
        : "RIKA_EMBEDDINGS_API_KEY is required for live thread memory indexing.",
  },
  {
    name: "permissions",
    status: "ok",
    message:
      input.permissionSummary.mode === "allow-all"
        ? "Permission policy is allow-all; tools run without approval by default."
        : `Permission policy mode is ${input.permissionSummary.mode}.`,
  },
  {
    name: "rivet",
    status: input.rivetHost === "remote" && input.rivetEndpoint.length === 0 ? "warning" : "ok",
    message:
      input.rivetHost === "remote"
        ? "Remote Rivet host mode is selected. Ensure endpoint/token are valid before serving users."
        : "Local Rivet host mode is selected.",
  },
  {
    name: "telemetry",
    status: "ok",
    message: input.telemetry.enabled
      ? `Telemetry exports traces and logs to ${input.telemetry.endpoint} (local OTLP). Set RIKA_TELEMETRY=off to disable.`
      : "Telemetry is disabled. Set RIKA_TELEMETRY=on to export traces and logs to a local OTLP endpoint.",
  },
]

const secretConfigured = (value: string | undefined) => value !== undefined && value.length > 0
