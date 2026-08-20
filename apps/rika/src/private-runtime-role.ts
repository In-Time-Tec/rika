export const serverProcessRole = "--internal-local-executor"

export interface ServerProcessRuntime {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
}

export const serverProcessRuntime = (input: {
  readonly packaged: boolean
  readonly executable: string
  readonly packagedEntrypoint: string
  readonly sourceEntrypoint: string
}): ServerProcessRuntime =>
  input.packaged
    ? { executable: input.packagedEntrypoint, arguments: [serverProcessRole] }
    : { executable: input.executable, arguments: [input.sourceEntrypoint, serverProcessRole] }

export const isServerProcessRole = (argv: ReadonlyArray<string>): boolean =>
  argv.length === 1 && argv[0] === serverProcessRole

export const isServerProcessLaunch = (): boolean => isServerProcessRole(process.argv.slice(2))
