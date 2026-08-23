import { runnerExecutorProcessRole, tuiControllerProcessRole } from "../private-runtime-role"

export type PerformanceRole = "launcher" | "interactive" | "runner-executor"

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
      ? { executable: sibling("rika"), arguments: [tuiControllerProcessRole], evidencePath: sibling("rika") }
      : { executable: input.executable, arguments: [source("interactive")], evidencePath: source("interactive") },
    "runner-executor": {
      executable: input.packaged ? sibling("rika") : input.executable,
      arguments: input.packaged ? [runnerExecutorProcessRole] : [source("client"), runnerExecutorProcessRole],
      evidencePath: input.packaged ? sibling("rika") : source("client"),
    },
  }
}

const executableName = (command: string) => {
  const executable = command.trim().split(/\s+/, 1)[0] ?? ""
  return executable.slice(executable.lastIndexOf("/") + 1)
}

const containsTuiControllerRole = (command: string) => command.trim().split(/\s+/).includes(tuiControllerProcessRole)
const containsLocalExecutorRole = (command: string) => command.trim().split(/\s+/).includes(runnerExecutorProcessRole)

export const matchesRole = (input: { readonly command: string; readonly runtime: RoleRuntime }): boolean => {
  if (input.runtime.arguments.includes(tuiControllerProcessRole)) return containsTuiControllerRole(input.command)
  if (input.runtime.arguments.includes(runnerExecutorProcessRole)) return containsLocalExecutorRole(input.command)
  if (containsTuiControllerRole(input.command) || containsLocalExecutorRole(input.command)) return false
  return input.runtime.evidencePath === input.runtime.executable
    ? executableName(input.command) === executableName(input.runtime.executable)
    : input.command.includes(input.runtime.evidencePath)
}
