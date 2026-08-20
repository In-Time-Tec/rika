const under = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.endsWith("/") ? root.slice(0, -1) : root, ...segments].join("/")

export interface ProfileDataPathOptions {
  readonly home: string
  readonly hostDataRoot?: string | undefined
  readonly productDatabase?: string | undefined
  readonly tenetkitDatabase?: string | undefined
}

export interface ProfileDataPaths {
  readonly dataRoot: string
  readonly database: string
  readonly tenetkitDatabase: string
}

export const tenetkitDatabaseName = "tenetkit.db"

export const dataPaths = (home: string): ProfileDataPaths => ({
  dataRoot: under(home, ".rika"),
  database: under(home, ".rika", "rika.db"),
  tenetkitDatabase: under(home, ".rika", tenetkitDatabaseName),
})

export const resolveProfileDataPaths = (options: ProfileDataPathOptions): ProfileDataPaths => {
  if (options.hostDataRoot !== undefined)
    return {
      dataRoot: options.hostDataRoot,
      database: under(options.hostDataRoot, "rika.db"),
      tenetkitDatabase: under(options.hostDataRoot, tenetkitDatabaseName),
    }
  const defaults = dataPaths(options.home)
  return {
    dataRoot: defaults.dataRoot,
    database: options.productDatabase ?? defaults.database,
    tenetkitDatabase: options.tenetkitDatabase ?? defaults.tenetkitDatabase,
  }
}
