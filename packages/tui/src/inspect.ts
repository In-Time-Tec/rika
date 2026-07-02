import { Telemetry } from "@rika/core"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import type * as ViewState from "./view-state"

export const command = (env: Record<string, string | undefined> = process.env): readonly [string, string] => {
  const bun = env.RIKA_BUN_EXECUTABLE ?? "bun"
  const script = env.RIKA_INSPECT_SCRIPT ?? resolveInspectScript()
  return [bun, script]
}

export const workingDirectory = (launch: readonly [string, string]): string => dirname(launch[1])

export const environment = (target: ViewState.InspectTarget): Record<string, string> => {
  const endpoint = trimTrailingSlash(process.env.RIKA_TELEMETRY_ENDPOINT ?? Telemetry.defaultEndpoint)
  return childEnv({
    ...process.env,
    MOTEL_OTEL_BASE_URL: endpoint,
    MOTEL_OTEL_QUERY_URL: endpoint,
    MOTEL_TUI_SERVICE_NAME: Telemetry.serviceName,
    MOTEL_TUI_ATTR_KEY: target.scope === "thread" ? "rika.thread_id" : undefined,
    MOTEL_TUI_ATTR_VALUE: target.scope === "thread" ? target.thread_id : undefined,
    MOTEL_TUI_THEME: process.env.MOTEL_TUI_THEME ?? "rika",
  })
}

const resolveInspectScript = (): string => {
  const installed = join(dirname(process.execPath), "..", "share", "rika", "inspect", "inspect.js")
  if (existsSync(installed)) return installed
  const localScript = resolveLocalInspectScript()
  if (localScript !== undefined) return localScript
  try {
    return Bun.resolveSync("@rika/motel/src/motel.ts", process.cwd())
  } catch {}
  throw new Error("Cannot find bundled Rika Inspect. Run bun install or reinstall Rika.")
}

const resolveLocalInspectScript = (): string | undefined => {
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

const childEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) values[key] = value
  }
  return values
}

const trimTrailingSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value)
