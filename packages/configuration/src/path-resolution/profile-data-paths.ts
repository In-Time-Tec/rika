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

export const dataPaths = (home: string): ProfileDataPaths => ({
  dataRoot: under(home, ".rika"),
  database: under(home, ".rika", "rika.db"),
  executionDatabase: under(home, ".rika", "execution.db"),
})

export const resolveProfileDataPaths = (options: ProfileDataPathOptions): ProfileDataPaths => {
  if (options.hostDataRoot !== undefined)
    return {
      dataRoot: options.hostDataRoot,
      database: under(options.hostDataRoot, "rika.db"),
      executionDatabase: under(options.hostDataRoot, "execution.db"),
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

export const executionEventHistoryFor = (executionDatabase: string): string =>
  under(parentDirectory(executionDatabase), "execution-event-history")
