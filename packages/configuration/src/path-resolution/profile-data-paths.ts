const under = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.endsWith("/") ? root.slice(0, -1) : root, ...segments].join("/")

export interface ProfileDataPathOptions {
  readonly home: string
  readonly hostDataRoot?: string | undefined
}

export interface ProfileDataPaths {
  readonly dataRoot: string
}

export const dataPaths = (home: string): ProfileDataPaths => ({ dataRoot: under(home, ".rika") })

export const resolveProfileDataPaths = (options: ProfileDataPathOptions): ProfileDataPaths => ({
  dataRoot: options.hostDataRoot ?? dataPaths(options.home).dataRoot,
})
