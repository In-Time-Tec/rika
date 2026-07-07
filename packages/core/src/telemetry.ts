import { context, diag, trace } from "@opentelemetry/api"
import type { Attributes, Span as OtelSpan } from "@opentelemetry/api"
import { SeverityNumber, logs } from "@opentelemetry/api-logs"
import type { Logger as OtelLogger } from "@opentelemetry/api-logs"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Tracer from "@effect/opentelemetry/Tracer"
import { Effect, Layer, Option } from "effect"
import * as Diagnostics from "./diagnostics"
import * as EnvConfig from "./env-config"
import * as SecretRedactor from "./secret-redactor"
import * as Settings from "./settings"

export const serviceName = "rika"
export const defaultEndpoint = Settings.defaultTelemetryEndpoint

export interface Options {
  readonly enabled: boolean
  readonly endpoint: string
  readonly version: string
  readonly environment: "development" | "production"
}

export const fromEnv = (env: Record<string, string | undefined>, version: string): Options => {
  const compiled = isCompiledBinary()
  const provider = EnvConfig.providerFromEnv(env, { booleanKeys: ["RIKA_TELEMETRY"] })
  const override = EnvConfig.optionalSync(provider, EnvConfig.boolean("RIKA_TELEMETRY"))
  const endpoint = trimTrailingSlash(env.RIKA_TELEMETRY_ENDPOINT ?? defaultEndpoint)
  return {
    enabled: override ?? true,
    endpoint,
    version,
    environment: compiled ? "production" : "development",
  }
}

export const fromSettingsSnapshot = (snapshot: Settings.Snapshot, version: string): Options => ({
  enabled: snapshot.values.telemetry.enabled,
  endpoint: trimTrailingSlash(snapshot.values.telemetry.endpoint),
  version,
  environment: isCompiledBinary() ? "production" : "development",
})

export const suppressDiagnostics = () => diag.disable()

export const layer = (options: Options): Layer.Layer<never> => {
  const tracing = NodeSdk.layer(() => {
    suppressDiagnostics()
    return {
      resource: {
        serviceName,
        serviceVersion: options.version,
        attributes: resourceAttributes(options),
      },
      spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` })),
    }
  })
  const logging = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        suppressDiagnostics()
        const provider = new LoggerProvider({
          resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: serviceName,
            [ATTR_SERVICE_VERSION]: options.version,
            ...resourceAttributes(options),
          }),
          processors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${options.endpoint}/v1/logs` }))],
        })
        logs.setGlobalLoggerProvider(provider)
        return provider
      }),
      (provider) => Effect.promise(() => provider.forceFlush().then(() => provider.shutdown())).pipe(Effect.ignore),
    ),
  )
  return Layer.merge(tracing, logging) as Layer.Layer<never>
}

export const diagnosticsLayer = (options: Options) =>
  Layer.effect(
    Diagnostics.Service,
    Effect.gen(function* () {
      const path = yield* Diagnostics.resolveLogPath()
      const redactor = yield* SecretRedactor.Service
      const fileEmit = Diagnostics.makeFileEmit(redactor, path)
      const otelLogger = logs.getLogger(serviceName, options.version)
      return Diagnostics.makeService(redactor, (entry) =>
        Effect.gen(function* () {
          yield* fileEmit(entry)
          const span = yield* Tracer.currentOtelSpan.pipe(Effect.option)
          yield* Effect.sync(() => emitLogRecord(otelLogger, entry, span))
        }),
      )
    }),
  )

const emitLogRecord = (logger: OtelLogger, entry: Diagnostics.Entry, span: Option.Option<OtelSpan>) => {
  try {
    const emitContext = Option.match(span, {
      onNone: () => undefined,
      onSome: (value) => trace.setSpan(context.active(), value),
    })
    logger.emit({
      severityNumber: severityFor(entry.level),
      severityText: entry.level,
      body: entry.message,
      attributes: attributesFor(entry),
      ...(emitContext === undefined ? {} : { context: emitContext }),
    })
  } catch {
    return
  }
}

const attributesFor = (entry: Diagnostics.Entry): Attributes => {
  const attributes: Attributes = {}
  if (isRecord(entry.data)) Object.assign(attributes, Diagnostics.attributesFromFields(entry.data))
  if (entry.data !== undefined) attributes.data = JSON.stringify(entry.data)
  return attributes
}

const severityByLevel: Record<Diagnostics.Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
}

const severityFor = (level: Diagnostics.Level): SeverityNumber => severityByLevel[level]

const resourceAttributes = (options: Options): Attributes => ({
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
  "process.runtime.name": "bun",
})

const isCompiledBinary = () => import.meta.url.includes("/$bunfs/")

const trimTrailingSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value)

const isRecord = (value: unknown): value is Diagnostics.Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)
