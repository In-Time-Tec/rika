import { Cause, Exit, Runtime } from "effect"

export const clientProcessExitCode = <E, A>(input: {
  readonly exit: Exit.Exit<E, A>
  readonly interruptedBySigint: boolean
}): number => {
  if (input.interruptedBySigint && Exit.isFailure(input.exit) && Cause.hasInterruptsOnly(input.exit.cause)) return 0
  let code = 1
  Runtime.defaultTeardown(input.exit, (value) => {
    code = value
  })
  return code
}
