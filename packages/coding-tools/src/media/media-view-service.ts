import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Output, type AnalysisInput, type MediaKind } from "./media-view-contract"
import { MediaMissingError, MediaOversizedError, UnsupportedMediaError } from "./media-view-errors"

export class MediaAnalysisError extends Schema.TaggedErrorClass<MediaAnalysisError>()("MediaAnalysisError", {
  message: Schema.String,
}) {}

interface AnalyzerInterface {
  readonly analyze: (input: AnalysisInput) => Effect.Effect<string, MediaAnalysisError>
}
export class MediaAnalyzer extends Context.Service<MediaAnalyzer, AnalyzerInterface>()(
  "@rika/coding-tools/media/media-view-service/MediaAnalyzer",
) {}
export const analyzerTestLayer = (analyze: AnalyzerInterface["analyze"]) =>
  Layer.succeed(MediaAnalyzer, MediaAnalyzer.of({ analyze }))
export const analyzerUnavailableLayer = analyzerTestLayer(() =>
  Effect.fail(MediaAnalysisError.make({ message: "Media analysis route is not configured" })),
)

export interface Interface {
  readonly view: (
    path: string,
  ) => Effect.Effect<Output, MediaMissingError | MediaOversizedError | UnsupportedMediaError | MediaAnalysisError>
}
export class Service extends Context.Service<Service, Interface>()(
  "@rika/coding-tools/media/media-view-service/Service",
) {}

const maximumSize = 25 * 1024 * 1024
const outputLimit = 40_000
const ascii = (bytes: Uint8Array, start: number, length: number) =>
  new TextDecoder().decode(bytes.slice(start, start + length))
const classify = (bytes: Uint8Array): { readonly mimeType: string; readonly kind: MediaKind } | undefined => {
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return { mimeType: "image/png", kind: "image" }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mimeType: "image/jpeg", kind: "image" }
  if (ascii(bytes, 0, 3) === "GIF") return { mimeType: "image/gif", kind: "image" }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return { mimeType: "image/webp", kind: "image" }
  if (ascii(bytes, 0, 5) === "%PDF-") return { mimeType: "application/pdf", kind: "pdf" }
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0))
    return { mimeType: "audio/mpeg", kind: "audio" }
  if (ascii(bytes, 4, 4) === "ftyp") return { mimeType: "video/mp4", kind: "video" }
  if (ascii(bytes, 0, 4) === "OggS") return { mimeType: "audio/ogg", kind: "audio" }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return { mimeType: "audio/wav", kind: "audio" }
  return undefined
}
const dimensions = (bytes: Uint8Array, mimeType: string) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mimeType === "image/png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) }
  if (mimeType === "image/gif" && bytes.length >= 10)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (mimeType === "image/webp" && ascii(bytes, 12, 4) === "VP8X" && bytes.length >= 30)
    return {
      width: 1 + bytes[24]! + bytes[25]! * 256 + bytes[26]! * 65_536,
      height: 1 + bytes[27]! + bytes[28]! * 256 + bytes[29]! * 65_536,
    }
  return {}
}

export const layer = (workspace: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const analyzer = yield* MediaAnalyzer
      return Service.of({
        view: Effect.fn("MediaView.view")(function* (relativePath) {
          const target = pathService.resolve(workspace, relativePath)
          const exists = yield* fileSystem
            .exists(target)
            .pipe(Effect.mapError(() => MediaMissingError.make({ path: relativePath })))
          if (!exists) return yield* MediaMissingError.make({ path: relativePath })
          const canonicalTarget = yield* fileSystem
            .realPath(target)
            .pipe(Effect.mapError(() => MediaMissingError.make({ path: relativePath })))
          const info = yield* fileSystem
            .stat(canonicalTarget)
            .pipe(Effect.mapError(() => MediaMissingError.make({ path: relativePath })))
          const size = Number(info.size)
          if (info.type !== "File") return yield* UnsupportedMediaError.make({ path: relativePath })
          if (size > maximumSize)
            return yield* MediaOversizedError.make({ path: relativePath, size, maximum: maximumSize })
          const bytes = yield* fileSystem
            .readFile(canonicalTarget)
            .pipe(Effect.mapError(() => MediaMissingError.make({ path: relativePath })))
          const media = classify(bytes)
          if (media === undefined) return yield* UnsupportedMediaError.make({ path: relativePath })
          const artifact = {
            path: relativePath,
            mimeType: media.mimeType,
            kind: media.kind,
            size,
            ...dimensions(bytes, media.mimeType),
          }
          if (media.kind === "image") {
            const text = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(artifact).pipe(Effect.orDie)
            return { text, artifact, truncated: false }
          }
          const analysis = yield* analyzer.analyze({ ...artifact, bytes })
          return { text: analysis.slice(0, outputLimit), artifact, truncated: analysis.length > outputLimit }
        }),
      })
    }),
  )

export const testLayer = (view: Interface["view"]) => Layer.succeed(Service, Service.of({ view }))
