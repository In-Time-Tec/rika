export const installRootEnv = "RIKA_INSTALL_ROOT"

export const binDirEnv = "RIKA_BIN_DIR"

export const binDirSegments = [".local", "bin"] as const

export const releaseRootSegments = [".local", "share", "rika", "current"] as const

export const devRootSegments = [".local", "share", "rika-dev", "current"] as const

export const defaultInstallRoot = `$HOME/${releaseRootSegments.join("/")}`

export const defaultBinDir = `$HOME/${binDirSegments.join("/")}`
