import { createCliRenderer } from "@opentui/core"
import { Clock, Effect, Schema } from "effect"
import type { Handlers, SurfaceOptions } from "./state"

export class AdapterError extends Schema.TaggedError<AdapterError>()("TuiAdapterError", {
  message: Schema.String,
}) {}

const adapterError = (cause: unknown) => AdapterError.make({ message: String(cause) })

export interface TerminalSurface {
  destroy(): void
}

type FullRepaintRenderer = {
  forceFullRepaintRequested: boolean
}

const createSurfaceAdapter = <Surface extends TerminalSurface>(
  Surface: new (
    renderer: Awaited<ReturnType<typeof createCliRenderer>>,
    handlers: Handlers,
    options: SurfaceOptions,
  ) => Surface,
  handlers: Handlers,
) =>
  (handlers.makeRenderer === undefined
    ? Effect.tryPromise({
        try: () =>
          createCliRenderer({
            screenMode: "alternate-screen",
            exitOnCtrlC: false,
            exitSignals: [],
            useMouse: true,
            enableMouseMovement: true,
          }),
        catch: adapterError,
      })
    : handlers.makeRenderer()
  ).pipe(
    Effect.flatMap((renderer) =>
      Effect.gen(function* () {
        const epochMillis = yield* Clock.currentTimeMillis
        return yield* Effect.try({
          try: () => {
            let surface: Surface | undefined
            let released = false
            const releaseTerminal = () => {
              if (released) return
              released = true
              try {
                surface?.destroy()
              } catch (cause) {
                handlers.warning?.("tui.surface.destroy.failed", cause)
              } finally {
                try {
                  renderer.destroy()
                } catch (cause) {
                  handlers.warning?.("tui.renderer.destroy.failed", cause)
                }
              }
            }
            const suspendTerminal = () => {
              if (released) return
              try {
                renderer.suspend()
              } catch (cause) {
                releaseTerminal()
                throw cause
              }
            }
            const resumeTerminal = () => {
              if (released) return
              try {
                renderer.resume()
              } catch (cause) {
                releaseTerminal()
                throw cause
              }
            }
            const redrawTerminal = () => {
              if (released) return
              ;(renderer as unknown as FullRepaintRenderer).forceFullRepaintRequested = true
              renderer.requestRender()
            }
            try {
              renderer.setBackgroundColor("transparent")
              handlers.resize(renderer.terminalWidth, renderer.terminalHeight)
              surface = new Surface(renderer, handlers, { epochMillis })
              return { surface, releaseTerminal, suspendTerminal, resumeTerminal, redrawTerminal }
            } catch (cause) {
              releaseTerminal()
              throw cause
            }
          },
          catch: adapterError,
        })
      }),
    ),
  )

export const SurfaceAdapter = {
  create<Surface extends TerminalSurface>(
    Surface: new (
      renderer: Awaited<ReturnType<typeof createCliRenderer>>,
      handlers: Handlers,
      options: SurfaceOptions,
    ) => Surface,
    handlers: Handlers,
  ) {
    return createSurfaceAdapter(Surface, handlers)
  },
}
