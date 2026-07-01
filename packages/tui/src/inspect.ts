import { Telemetry } from "@rika/core"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import * as ViewState from "./view-state"

export class InspectLoadError extends Error {
  readonly _tag = "InspectLoadError"
}

export const load = Effect.fn("Tui.Inspect.load")(function* (target: ViewState.InspectTarget, workspacePath: string) {
  const endpoint = trimTrailingSlash(process.env.RIKA_TELEMETRY_ENDPOINT ?? Telemetry.defaultEndpoint)
  return yield* Effect.tryPromise({
    try: async () => {
      await ensureEndpoint(endpoint, workspacePath)
      const [tracePage, spanPage, logPage] = await Promise.all([
        getJson(endpoint, queryPath("/api/traces/search", target, 50)),
        getJson(endpoint, queryPath("/api/spans/search", target, 200)),
        getJson(endpoint, queryPath("/api/logs/search", target, 120)),
      ])
      const traces = dataArray(tracePage).map(traceSummary).filter(isDefined)
      const spans = dataArray(spanPage).map(spanItem).filter(isDefined)
      const logs = dataArray(logPage).map(logItem).filter(isDefined)
      return {
        traces,
        spans,
        logs,
        fetched_at: Date.now(),
        ...(traces[0] === undefined ? {} : { selected_trace_id: traces[0].trace_id }),
      }
    },
    catch: (error) => new InspectLoadError(error instanceof Error ? error.message : String(error)),
  })
})

const ensureEndpoint = async (endpoint: string, workspacePath: string) => {
  if (await healthy(endpoint)) return
  await spawnTelemetryDaemon(endpoint, workspacePath)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await healthy(endpoint)) return
    await sleep(100)
  }
  throw new Error(`Rika Inspect did not become ready at ${endpoint}`)
}

const healthy = async (endpoint: string): Promise<boolean> => {
  try {
    const response = await fetch(`${endpoint}/api/health`, { signal: AbortSignal.timeout(750) })
    if (!response.ok) return false
    const body = asRecord(await response.json())
    return body?.ok === true
  } catch {
    return false
  }
}

const spawnTelemetryDaemon = async (endpoint: string, workspacePath: string) => {
  const command = telemetryCommand()
  const launched = Bun.spawn([...command, "daemon"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    cwd: dirname(command[1]),
    env: childEnv({
      ...process.env,
      RIKA_WORKSPACE_ROOT: workspacePath,
      MOTEL_OTEL_BASE_URL: endpoint,
      MOTEL_OTEL_QUERY_URL: endpoint,
    }),
  })
  const exitCode = await launched.exited
  if (exitCode !== 0) throw new Error(`Rika Inspect daemon exited ${exitCode}`)
}

const telemetryCommand = (env: Record<string, string | undefined> = process.env): readonly [string, string] => {
  const bun = env.RIKA_BUN_EXECUTABLE ?? "bun"
  const script = env.RIKA_INSPECT_SCRIPT ?? resolveTelemetryScript()
  return [bun, script]
}

const resolveTelemetryScript = (): string => {
  const installed = join(dirname(process.execPath), "..", "share", "rika", "inspect", "inspect.js")
  if (existsSync(installed)) return installed
  const localScript = resolveLocalTelemetryScript()
  if (localScript !== undefined) return localScript
  try {
    return Bun.resolveSync("@rika/motel/src/motel.ts", process.cwd())
  } catch {}
  throw new Error("Cannot find bundled Rika Inspect. Run bun install or reinstall Rika.")
}

const resolveLocalTelemetryScript = (): string | undefined => {
  for (const root of candidateRoots()) {
    const script = join(root, "packages", "motel", "src", "motel.ts")
    if (existsSync(script)) return script
  }
  return undefined
}

const candidateRoots = (): ReadonlyArray<string> => {
  const roots = []
  let current = process.cwd()
  while (true) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

const childEnv = (env: Record<string, string | undefined>) => {
  const values = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete values[key]
    else values[key] = value
  }
  return values
}

const queryPath = (path: string, target: ViewState.InspectTarget, limit: number): string => {
  const url = new URL(path, "http://unused.local")
  url.searchParams.set("service", Telemetry.serviceName)
  url.searchParams.set("limit", String(limit))
  if (target.scope === "thread") url.searchParams.set("attr.rika.thread_id", target.thread_id)
  return `${url.pathname}${url.search}`
}

const getJson = async (endpoint: string, path: string): Promise<unknown> => {
  const response = await fetch(new URL(path, endpoint), { signal: AbortSignal.timeout(5000) })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(errorDetail(body) ?? `HTTP ${response.status}`)
  return body
}

const traceSummary = (value: unknown): ViewState.InspectTraceSummary | undefined => {
  const item = asRecord(value)
  if (item === undefined) return undefined
  const traceId = stringField(item, "traceId")
  const serviceName = stringField(item, "serviceName")
  const operationName = stringField(item, "rootOperationName")
  const startedAt = timeField(item, "startedAt")
  if (traceId === undefined || serviceName === undefined || operationName === undefined || startedAt === undefined) {
    return undefined
  }
  return {
    trace_id: traceId,
    service_name: serviceName,
    operation_name: operationName,
    started_at: startedAt,
    duration_ms: numberField(item, "durationMs") ?? 0,
    span_count: numberField(item, "spanCount") ?? 0,
    error_count: numberField(item, "errorCount") ?? 0,
    running: booleanField(item, "isRunning") ?? false,
  }
}

const spanItem = (value: unknown): ViewState.InspectSpan | undefined => {
  const item = asRecord(value)
  const span = asRecord(item?.span)
  if (item === undefined || span === undefined) return undefined
  const traceId = stringField(item, "traceId")
  const spanId = stringField(span, "spanId")
  const serviceName = stringField(span, "serviceName")
  const operationName = stringField(span, "operationName")
  if (traceId === undefined || spanId === undefined || serviceName === undefined || operationName === undefined) {
    return undefined
  }
  const parentSpanId = stringField(span, "parentSpanId")
  const status = stringField(span, "status") === "error" ? "error" : "ok"
  return {
    trace_id: traceId,
    span_id: spanId,
    ...(parentSpanId === undefined ? {} : { parent_span_id: parentSpanId }),
    service_name: serviceName,
    operation_name: operationName,
    duration_ms: numberField(span, "durationMs") ?? 0,
    status,
    depth: numberField(span, "depth") ?? 0,
  }
}

const logItem = (value: unknown): ViewState.InspectLog | undefined => {
  const item = asRecord(value)
  if (item === undefined) return undefined
  const id = stringField(item, "id")
  const timestamp = timeField(item, "timestamp")
  const body = stringField(item, "body")
  if (id === undefined || timestamp === undefined || body === undefined) return undefined
  const traceId = stringField(item, "traceId")
  const spanId = stringField(item, "spanId")
  return {
    id,
    timestamp,
    severity: stringField(item, "severityText") ?? "INFO",
    body,
    ...(traceId === undefined ? {} : { trace_id: traceId }),
    ...(spanId === undefined ? {} : { span_id: spanId }),
  }
}

const dataArray = (value: unknown): ReadonlyArray<unknown> => {
  const body = asRecord(value)
  return Array.isArray(body?.data) ? body.data : []
}

const errorDetail = (value: unknown): string | undefined => {
  const body = asRecord(value)
  return stringField(body, "error")
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (value: Record<string, unknown> | undefined, key: string): string | undefined => {
  const field = value?.[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

const numberField = (value: Record<string, unknown>, key: string): number | undefined => {
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

const booleanField = (value: Record<string, unknown>, key: string): boolean | undefined => {
  const field = value[key]
  return typeof field === "boolean" ? field : undefined
}

const timeField = (value: Record<string, unknown>, key: string): number | undefined => {
  const field = value[key]
  if (typeof field === "number" && Number.isFinite(field)) return field
  if (typeof field !== "string") return undefined
  const parsed = Date.parse(field)
  return Number.isFinite(parsed) ? parsed : undefined
}

const isDefined = <A>(value: A | undefined): value is A => value !== undefined

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const trimTrailingSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value)
