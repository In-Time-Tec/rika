export type PerformanceRole = "launcher" | "interactive" | "server"

export interface RoleObservation {
  readonly role: PerformanceRole
  readonly pid: number
  readonly executable: string
  readonly rssMebibytes: number
  readonly cpuPercent: number
}

export interface ProcessObservation {
  readonly roles: ReadonlyArray<RoleObservation>
  readonly sampleCount?: number
  readonly terminalColumns?: number
  readonly terminalRows?: number
  readonly startupToRolePresenceMilliseconds?: number
  readonly idleCpuMeanPercent?: number
  readonly idleCpuPeakPercent?: number
  readonly executableBytes: Readonly<Record<PerformanceRole, number>>
  readonly unsupportedReason?: string
}

export interface RoleRuntime {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly evidencePath: string
}

export const roleRuntimes = (input: {
  readonly packaged: boolean
  readonly executable: string
  readonly sourceDirectory: string
}): Readonly<Record<PerformanceRole, RoleRuntime>> => {
  const sibling = (name: string) => `${input.sourceDirectory}/${name}`
  const source = (name: string) => `${input.sourceDirectory}/${name}-main.ts`
  return {
    launcher: {
      executable: input.packaged ? sibling("rika") : input.executable,
      arguments: input.packaged ? [] : [source("client")],
      evidencePath: input.packaged ? sibling("rika") : source("client"),
    },
    interactive: input.packaged
      ? { executable: sibling(".rika-interactive"), arguments: [], evidencePath: sibling(".rika-interactive") }
      : { executable: input.executable, arguments: [source("interactive")], evidencePath: source("interactive") },
    server: input.packaged
      ? { executable: sibling(".rika-server"), arguments: [], evidencePath: sibling(".rika-server") }
      : { executable: input.executable, arguments: [source("server")], evidencePath: source("server") },
  }
}
