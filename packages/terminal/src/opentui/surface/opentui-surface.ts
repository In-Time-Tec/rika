import { createCliRenderer } from "@opentui/core"
import { Clock as EffectClock, Effect, Schema } from "effect"
import { SurfaceConstruction } from "./opentui-surface-construction"
import type { Handlers, SurfaceOptions } from "./opentui-surface-state"
import { renderBlock, renderChangedFiles, renderSidebar } from "../rendering/opentui-render-block"
import {
  probeNativeAsset,
  idleSpinnerFrame,
  loaderFrame,
  spinnerFrames,
  spinnerInterval,
  statusSpinnerFrames,
  ToolSpinner,
} from "../rendering/opentui-spinner"
import {
  renderTranscriptStyled,
  boundedTranscriptModel,
  buildTranscript,
  maxBoundedTranscriptItems,
  maxMountedTranscriptEntries,
  transcriptWrapWidth,
} from "../rendering/opentui-renderer"
import { clipStyledLine, previewBoxRows } from "./opentui-overlay-content"
import { formatTokens } from "../../presentation/terminal/terminal-format"

export {
  renderBlock,
  renderChangedFiles,
  renderSidebar,
  idleSpinnerFrame,
  loaderFrame,
  probeNativeAsset,
  spinnerFrames,
  spinnerInterval,
  statusSpinnerFrames,
  ToolSpinner,
  renderTranscriptStyled,
  boundedTranscriptModel,
  buildTranscript,
  maxBoundedTranscriptItems,
  maxMountedTranscriptEntries,
  transcriptWrapWidth,
}
export { clipStyledLine, previewBoxRows }
export type { Handlers, SurfaceOptions }
export { maxMountedTranscriptRows } from "../../presentation/transcript/terminal-transcript-presentation"
export { formatTokens }

export class AdapterError extends Schema.TaggedErrorClass<AdapterError>()("TuiAdapterError", {
  message: Schema.String,
}) {}
const adapterError = (cause: unknown) => AdapterError.make({ message: String(cause) })

export class Surface extends SurfaceConstruction {}

export const create = (handlers: Handlers) =>
  Effect.tryPromise({
    try: () =>
      handlers.makeRenderer === undefined
        ? createCliRenderer({
            screenMode: "alternate-screen",
            exitOnCtrlC: false,
            exitSignals: [],
            useMouse: true,
            enableMouseMovement: true,
          })
        : handlers.makeRenderer(),
    catch: adapterError,
  }).pipe(
    Effect.flatMap((renderer) =>
      Effect.gen(function* () {
        const epochMillis = yield* EffectClock.currentTimeMillis
        return yield* Effect.try({
          try: () => {
            let surface: Surface | undefined
            let released = false
            const releaseTerminal = () => {
              if (released) return
              released = true
              try {
                surface?.destroy()
              } catch {
              } finally {
                try {
                  renderer.destroy()
                } catch {}
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
            try {
              renderer.setBackgroundColor("transparent")
              handlers.resize(renderer.terminalWidth, renderer.terminalHeight)
              surface = new Surface(renderer, handlers, { epochMillis })
              return { surface, releaseTerminal, suspendTerminal, resumeTerminal }
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
