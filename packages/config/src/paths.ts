export const workspaceDirectory = ".rika"

export const globalDirectory = ".config/rika"

const under = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.endsWith("/") ? root.slice(0, -1) : root, ...segments].join("/")

export const workspacePaths = (workspace: string) => ({
  settings: under(workspace, workspaceDirectory, "settings.json"),
  skills: under(workspace, workspaceDirectory, "skills"),
  mcpConfig: under(workspace, workspaceDirectory, "mcp.json"),
  extensionGenerations: under(workspace, workspaceDirectory, "extensions.json"),
  pasted: under(workspace, workspaceDirectory, "pasted"),
})

export const globalPaths = (home: string) => ({
  settings: under(home, globalDirectory, "settings.json"),
  skills: under(home, globalDirectory, "skills"),
  mcpOAuth: under(home, globalDirectory, "mcp-oauth.json"),
  extensionRoot: under(home, globalDirectory, "extensions"),
})

export const executionDatabaseName = "execution-v2.db"

export const dataRootPaths = (root: string) => ({
  database: under(root, "rika.db"),
  executionDatabase: under(root, executionDatabaseName),
})

export const dataPaths = (home: string) => dataRootPaths(under(home, workspaceDirectory))

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
