import { presetForBase } from "../model-routing/model-preset"
import type { ConfigurationEnvironment } from "./configuration-settings"
import type { SettingsInput } from "./configuration-settings-input"

export interface ConfigurationDiagnostic {
  readonly path: string
  readonly source: "default" | "global" | "workspace" | "environment"
  readonly message: string
}

export type Diagnostic = ConfigurationDiagnostic

export const configurationDiagnostics = (
  global: SettingsInput,
  workspace: SettingsInput,
  environment: ConfigurationEnvironment,
): ReadonlyArray<ConfigurationDiagnostic> => {
  const entries: Array<ConfigurationDiagnostic> = []
  const record = (input: SettingsInput, source: "global" | "workspace") => {
    for (const path of Object.keys(input).toSorted()) entries.push({ path, source, message: `${source} value applied` })
  }
  record(global, "global")
  record(workspace, "workspace")
  for (const [source, input] of [
    ["global", global],
    ["workspace", workspace],
  ] as const)
    for (const [name, alias] of Object.entries(input.modelAliases ?? {}))
      if (alias.base !== undefined)
        entries.push({
          path: `modelAliases.${name}.base`,
          source,
          message: `deprecated base "${alias.base}"; replace with preset "${presetForBase(alias.base)}" and set displayName`,
        })
  for (const providerId of Object.keys(environment.webSearchCredentials).toSorted())
    entries.push({
      path: `webSearchCredentials.${providerId}`,
      source: "environment",
      message: "environment value applied (redacted)",
    })
  for (const variable of Object.keys(environment.providerCredentials).toSorted())
    entries.push({
      path: `providerCredentials.${variable}`,
      source: "environment",
      message: "environment value applied (redacted)",
    })
  return entries
}
