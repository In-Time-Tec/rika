import { Duration } from "effect"

export const forceQuitWindow = Duration.seconds(2)

export type TuiLifecycle =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Quitting"; readonly lastInterruptAt: number | undefined }
  | { readonly _tag: "TornDown" }

export type InterruptDecision =
  | { readonly _tag: "Cancel" }
  | { readonly _tag: "Quit" }
  | { readonly _tag: "ForceQuit" }
  | { readonly _tag: "Ignore" }

export const interruptDecision = (input: {
  readonly lifecycle: TuiLifecycle
  readonly hasActiveWork: boolean
  readonly cancellationPending: boolean
  readonly now: number
}): InterruptDecision => {
  switch (input.lifecycle._tag) {
    case "Running":
      return input.hasActiveWork && !input.cancellationPending ? { _tag: "Cancel" } : { _tag: "Quit" }
    case "Quitting": {
      const last = input.lifecycle.lastInterruptAt
      if (last !== undefined && input.now - last <= Duration.toMillis(forceQuitWindow)) return { _tag: "ForceQuit" }
      return { _tag: "Quit" }
    }
    case "TornDown":
      return { _tag: "Ignore" }
  }
}
