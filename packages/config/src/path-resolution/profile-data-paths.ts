const under = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.endsWith("/") ? root.slice(0, -1) : root, ...segments].join("/")

export interface ProfileDataPathOptions {
  readonly home: string
  readonly hostDataRoot?: string | undefined
  readonly productDatabase?: string | undefined
  readonly batonDatabase?: string | undefined
}

export interface ProfileDataPaths {
  readonly dataRoot: string
  readonly database: string
  readonly batonDatabase: string
}

export const batonDatabaseName = "baton.db"

export const dataPaths = (home: string): ProfileDataPaths => ({
  dataRoot: under(home, ".rika"),
  database: under(home, ".rika", "rika.db"),
  batonDatabase: under(home, ".rika", batonDatabaseName),
})

export const resolveProfileDataPaths = (options: ProfileDataPathOptions): ProfileDataPaths => {
  if (options.hostDataRoot !== undefined)
    return {
      dataRoot: options.hostDataRoot,
      database: under(options.hostDataRoot, "rika.db"),
      batonDatabase: under(options.hostDataRoot, batonDatabaseName),
    }
  const defaults = dataPaths(options.home)
  return {
    dataRoot: defaults.dataRoot,
    database: options.productDatabase ?? defaults.database,
    batonDatabase: options.batonDatabase ?? defaults.batonDatabase,
  }
}
