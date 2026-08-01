import * as ResidentService from "@rika/product/resident-service"
import * as ResidentProcessStartup from "../resident/process/resident-process"

export const cleanInteractiveRuntimeExit = (exitCode: number): boolean =>
  exitCode === 0 || exitCode === 130 || exitCode === 129

export const interactiveRuntimeRestartLimit = 3

export type InteractiveRuntimeRestartDecision =
  | { readonly _tag: "respawn"; readonly environment: Record<string, string> }
  | { readonly _tag: "fail"; readonly message: string }
  | { readonly _tag: "done" }

export const interactiveRuntimeRestartPlan = (input: {
  readonly exitCode: number
  readonly restart: ResidentProcessStartup.RuntimeRestartMessage | undefined
  readonly attempt: number
  readonly limit: number
}): InteractiveRuntimeRestartDecision => {
  if (input.exitCode === ResidentService.ServiceRuntime.runtimeRestartExitCode && input.restart !== undefined) {
    if (input.attempt >= input.limit)
      return { _tag: "fail", message: "Rika could not finish upgrading. Reinstall Rika, then run it again." }
    return {
      _tag: "respawn",
      environment: {
        RIKA_INTERNAL_RUNTIME_RESTARTED: "1",
        ...(input.restart.threadId === undefined ? {} : { RIKA_INTERNAL_RESTART_THREAD: input.restart.threadId }),
      },
    }
  }
  if (cleanInteractiveRuntimeExit(input.exitCode)) return { _tag: "done" }
  return {
    _tag: "fail",
    message: "Rika closed unexpectedly. Run rika again. If it keeps happening, run rika diagnostics status.",
  }
}
