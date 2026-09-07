import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import type { CliRendererErrorEvent, CliRendererHandlerErrorEvent } from "@opentui/core"
import { render } from "@opentui/solid"
import { Data, Deferred, Effect } from "effect"
import { ErrorBoundary } from "solid-js"
import { App } from "./app"
import type { ScenarioId } from "./client/model"
import { createClient } from "./client/runtime"

export interface LaunchOptions {
  readonly scenario: ScenarioId
  readonly animate: boolean
}
class TerminalFailure extends Data.TaggedError("TerminalFailure")<{
  readonly message: string
}> {}

export const launch = Effect.fn("TuiV2.launch")(function* (options: LaunchOptions) {
  const quit = yield* Deferred.make<void, TerminalFailure>()
  const onQuit = () => {
    Deferred.doneUnsafe(quit, Effect.void)
  }
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => createClient({ scenario: options.scenario })),
    (resource) => resource.dispose,
  )
  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createCliRenderer({
          backgroundColor: "transparent",
          screenMode: "alternate-screen",
          exitOnCtrlC: false,
          exitSignals: [],
          useMouse: true,
          enableMouseMovement: true,
          openConsoleOnError: false,
          onDestroy: onQuit,
        }),
      catch: (cause) => new TerminalFailure({ message: String(cause) }),
    }),
    (resource) => Effect.sync(() => resource.destroy()),
  )
  const fail = (event: CliRendererErrorEvent | CliRendererHandlerErrorEvent) => {
    Deferred.doneUnsafe(quit, Effect.fail(new TerminalFailure({ message: String(event.error) })))
  }
  renderer.on(CliRenderEvents.RENDER_ERROR, fail)
  renderer.on(CliRenderEvents.HANDLER_ERROR, fail)
  yield* Effect.tryPromise({
    try: () =>
      render(
        () => (
          <ErrorBoundary
            fallback={(error: Error) => {
              Deferred.doneUnsafe(quit, Effect.fail(new TerminalFailure({ message: String(error) })))
              return <text>Unable to render the interface.</text>
            }}
          >
            <App client={client} onQuit={onQuit} animate={options.animate} />
          </ErrorBoundary>
        ),
        renderer,
      ),
    catch: (cause) => new TerminalFailure({ message: String(cause) }),
  })
  yield* Deferred.await(quit)
})
