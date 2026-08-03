const under = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.endsWith("/") ? root.slice(0, -1) : root, ...segments].join("/")

export interface ProfileDataPathOptions {
  readonly home: string
  readonly hostDataRoot?: string | undefined
  readonly productDatabase?: string | undefined
  readonly executionDatabase?: string | undefined
}

export interface ProfileDataPaths {
  readonly dataRoot: string
  readonly database: string
  readonly executionDatabase: string
}

export const executionDatabaseName = "execution-v2.db"

export const dataPaths = (home: string): ProfileDataPaths => ({
  dataRoot: under(home, ".rika"),
  database: under(home, ".rika", "rika.db"),
  executionDatabase: under(home, ".rika", executionDatabaseName),
})

export const resolveProfileDataPaths = (options: ProfileDataPathOptions): ProfileDataPaths => {
  if (options.hostDataRoot !== undefined)
    return {
      dataRoot: options.hostDataRoot,
      database: under(options.hostDataRoot, "rika.db"),
      executionDatabase: under(options.hostDataRoot, executionDatabaseName),
    }
  const defaults = dataPaths(options.home)
  return {
    dataRoot: defaults.dataRoot,
    database: options.productDatabase ?? defaults.database,
    executionDatabase: options.executionDatabase ?? defaults.executionDatabase,
  }
}

const parentDirectory = (filename: string): string => {
  const separator = filename.lastIndexOf("/")
  if (separator < 0) return "."
  if (separator === 0) return "/"
  return filename.slice(0, separator)
}

const filenameStem = (filename: string): string => {
  const separator = filename.lastIndexOf("/")
  const basename = separator < 0 ? filename : filename.slice(separator + 1)
  return basename.endsWith(".db") ? basename.slice(0, -3) : basename
}

export const executionEventHistoryFor = (executionDatabase: string): string =>
  under(parentDirectory(executionDatabase), `${filenameStem(executionDatabase)}-event-history`)
