export type PerformanceRuntimeKind = "packaged" | "source"

export interface ProcessIdentity {
  readonly pid: number
  readonly executable: string
  readonly runtimeKind: PerformanceRuntimeKind
}

export interface ProcessMeasurement extends ProcessIdentity {
  readonly rssMebibytes: number
  readonly cpuPercent: number
}

export interface ProcessObservation {
  readonly client?: ProcessMeasurement
  readonly sampleCount?: number
  readonly descendantCount?: number
  readonly terminalColumns?: number
  readonly terminalRows?: number
  readonly startupToProcessPresenceMilliseconds?: number
  readonly idleCpuMeanPercent?: number
  readonly idleCpuPeakPercent?: number
  readonly executableBytes: number
  readonly unsupportedReason?: string
}

export interface ClientRuntime {
  readonly kind: PerformanceRuntimeKind
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly evidencePath: string
}

export const clientRuntime = (input: {
  readonly packaged: boolean
  readonly executable: string
  readonly sourceDirectory: string
}): ClientRuntime => {
  const executable = input.packaged ? `${input.sourceDirectory}/rika` : input.executable
  const evidencePath = input.packaged ? executable : `${input.sourceDirectory}/client-main.ts`
  return {
    kind: input.packaged ? "packaged" : "source",
    executable,
    arguments: input.packaged ? [] : [evidencePath],
    evidencePath,
  }
}

const executableName = (command: string) => {
  const executable = command.trim().split(/\s+/, 1)[0] ?? ""
  return executable.slice(executable.lastIndexOf("/") + 1)
}

export const matchesClientProcess = (input: { readonly command: string; readonly runtime: ClientRuntime }): boolean =>
  input.runtime.evidencePath === input.runtime.executable
    ? executableName(input.command) === executableName(input.runtime.executable)
    : input.command.includes(input.runtime.evidencePath)
