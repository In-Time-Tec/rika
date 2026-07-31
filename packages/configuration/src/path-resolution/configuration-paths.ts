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
