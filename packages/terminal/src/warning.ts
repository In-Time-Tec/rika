export type WarningReporter = (event: string, cause: unknown) => void

const reporters = new Set<WarningReporter>()

export const registerWarningReporter = (reporter: WarningReporter): (() => void) => {
  reporters.add(reporter)
  return () => reporters.delete(reporter)
}

export const Warning = {
  log(event: string, cause: unknown): void {
    for (const reporter of reporters) reporter(event, cause)
  },
}
