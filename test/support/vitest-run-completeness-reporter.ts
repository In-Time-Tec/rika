import type { Reporter, TestCase, TestModule, TestSpecification, Vitest } from "vitest/node"

interface CompletionDetail {
  readonly reason: string
  readonly unhandledErrors?: number
}

const failExit = (): void => {
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
}

export class CompletionReporter implements Reporter {
  private active = false
  private ended = true
  private expectedFiles = 0
  private readonly collectedFiles = new Set<string>()
  private readonly endedFiles = new Set<string>()
  private readonly expectedTests = new Set<string>()
  private readonly completedTests = new Set<string>()
  private vitest: Vitest | undefined

  private readonly counts = () => ({
    files: { expected: this.expectedFiles, collected: this.collectedFiles.size, completed: this.endedFiles.size },
    tests: { expected: this.expectedTests.size, completed: this.completedTests.size },
  })

  private readonly line = (label: "COMPLETE" | "FAILED" | "INCOMPLETE", detail: CompletionDetail): string =>
    `VITEST RUN ${label} ${JSON.stringify({ ...detail, ...this.counts() })}`

  private readonly onExit = (): void => {
    if (!this.active || this.ended) return
    failExit()
    const sink = Bun.stderr.writer()
    void sink.write(`${this.line("INCOMPLETE", { reason: "process-exit-before-onTestRunEnd" })}\n`)
    void sink.flush()
  }

  onInit(vitest: Vitest): void {
    this.vitest = vitest
    process.once("exit", this.onExit)
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.active = true
    this.ended = false
    this.expectedFiles = specifications.length
    this.collectedFiles.clear()
    this.endedFiles.clear()
    this.expectedTests.clear()
    this.completedTests.clear()
  }

  onTestModuleCollected(testModule: TestModule): void {
    this.collectedFiles.add(testModule.id)
    for (const test of testModule.children.allTests()) this.expectedTests.add(test.id)
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.endedFiles.add(testModule.id)
  }

  onTestCaseResult(testCase: TestCase): void {
    this.completedTests.add(testCase.id)
  }

  onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: "passed" | "interrupted" | "failed",
  ): void {
    this.ended = true
    const incomplete =
      this.endedFiles.size !== this.expectedFiles || this.completedTests.size !== this.expectedTests.size
    const failed = reason !== "passed" || unhandledErrors.length > 0 || incomplete
    if (failed) failExit()
    const line = this.line(failed ? "FAILED" : "COMPLETE", { reason, unhandledErrors: unhandledErrors.length })
    if (failed) this.vitest?.logger.error(line)
    else this.vitest?.logger.log(line)
  }
}
