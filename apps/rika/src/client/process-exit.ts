import { Cause, Exit, Runtime } from "effect"

export const clientProcessExitCode = <E, A>(input: {
  readonly exit: Exit.Exit<E, A>
  readonly interruptedBySigint: boolean
  readonly successfulExitCode?: number | undefined
}): number => {
  if (input.interruptedBySigint && Exit.isFailure(input.exit) && Cause.hasInterruptsOnly(input.exit.cause)) return 0
  if (Exit.isSuccess(input.exit) && input.successfulExitCode !== undefined) return input.successfulExitCode
  let code = 1
  Runtime.defaultTeardown(input.exit, (value) => {
    code = value
  })
  return code
}
