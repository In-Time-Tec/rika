import { devCommandName, releaseCommandName } from "./install-command-names"
import { binDirEnv, defaultBinDir, defaultInstallRoot, installRootEnv } from "./install-paths"

export const installerDefaults = [
  { variable: installRootEnv, fallback: defaultInstallRoot },
  { variable: binDirEnv, fallback: defaultBinDir },
] as const

export const validateInstallerScript = (script: string): void => {
  for (const { variable, fallback } of installerDefaults) {
    const assignment = `\${${variable}:-${fallback}}`
    if (!script.includes(assignment))
      throw new Error(`install.sh must default ${variable} to ${fallback} using ${assignment}`)
  }
  if (!script.includes(`/${releaseCommandName}"`))
    throw new Error(`install.sh must link the ${releaseCommandName} command`)
  if (script.includes(devCommandName))
    throw new Error(`install.sh installs releases and must not reference ${devCommandName}`)
}
