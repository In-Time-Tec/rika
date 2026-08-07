import { Duration } from "effect"

export const forceQuitWindow = Duration.seconds(2)

export type InterruptDecision = { readonly _tag: "Cancel" } | { readonly _tag: "Quit" } | { readonly _tag: "ForceQuit" }

export const interruptDecision = (input: {
  readonly quitRequested: boolean
  readonly hasActiveWork: boolean
  readonly cancelRequested: boolean
  readonly sinceLastPress: Duration.Duration | undefined
}): InterruptDecision => {
  if (
    input.quitRequested &&
    input.sinceLastPress !== undefined &&
    Duration.isLessThanOrEqualTo(input.sinceLastPress, forceQuitWindow)
  )
    return { _tag: "ForceQuit" }
  if (!input.quitRequested && !input.cancelRequested && input.hasActiveWork) return { _tag: "Cancel" }
  return { _tag: "Quit" }
}
