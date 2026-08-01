export const archiveCommandName = "rika"

export const releaseCommandName = "rika"

export const devCommandName = "rika-dev"

export const installRootEnv = "RIKA_INSTALL_ROOT"

export const binDirEnv = "RIKA_BIN_DIR"

export const binDirSegments = [".local", "bin"] as const

export const releaseRootSegments = [".local", "share", "rika", "current"] as const

export const devRootSegments = [".local", "share", "rika-dev", "current"] as const

export const defaultInstallRoot = `$HOME/${releaseRootSegments.join("/")}`

export const defaultBinDir = `$HOME/${binDirSegments.join("/")}`

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
