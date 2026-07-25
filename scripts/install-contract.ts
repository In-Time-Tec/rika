export const commandName = "rika"

export const installRootEnv = "RIKA_INSTALL_ROOT"

export const binDirEnv = "RIKA_BIN_DIR"

export const installRootSegments = [".local", "share", "rika", "current"] as const

export const binDirSegments = [".local", "bin"] as const

export const defaultInstallRoot = `$HOME/${installRootSegments.join("/")}`

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
  if (!script.includes(`/${commandName}"`)) throw new Error(`install.sh must link the ${commandName} command`)
}
