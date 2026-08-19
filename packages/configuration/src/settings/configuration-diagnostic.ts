import type { ConfigurationEnvironment } from "./configuration-settings"
import type { ConfigurationSettingsInput } from "./configuration-settings-input"

export interface ConfigurationDiagnostic {
  readonly path: string
  readonly source: "default" | "global" | "workspace" | "environment"
  readonly message: string
}

export const configurationDiagnostics = ({
  global,
  workspace,
  environment,
}: {
  readonly global: ConfigurationSettingsInput
  readonly workspace: ConfigurationSettingsInput
  readonly environment: ConfigurationEnvironment
}): ReadonlyArray<ConfigurationDiagnostic> => {
  const entries: Array<ConfigurationDiagnostic> = []
  const record = (input: ConfigurationSettingsInput, source: "global" | "workspace") => {
    for (const path of Object.keys(input).toSorted()) entries.push({ path, source, message: `${source} value applied` })
  }
  record(global, "global")
  record(workspace, "workspace")
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
