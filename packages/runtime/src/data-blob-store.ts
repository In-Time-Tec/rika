import { BlobStore, type Content } from "@relayfx/sdk"
import { Effect, Layer } from "effect"

const maxBytes = 5_000_000
const maxEncodedBytes = Math.ceil(maxBytes / 3) * 4
const imageMediaTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export function decode(mediaType: string): (uri: string) => Uint8Array | undefined
export function decode(uri: string, mediaType: string): Uint8Array | undefined
export function decode(
  uriOrMediaType: string,
  mediaType?: string,
): Uint8Array | undefined | ((uri: string) => Uint8Array | undefined) {
  if (mediaType === undefined) return (uri) => decode(uri, uriOrMediaType)
  const uri = uriOrMediaType
  if (!imageMediaTypes.has(mediaType)) return undefined
  const prefix = `data:${mediaType};base64,`
  const payload = uri.startsWith(prefix) ? uri.slice(prefix.length) : undefined
  if (payload === undefined || payload.length === 0 || payload.length > maxEncodedBytes) return undefined
  const bytes = Buffer.from(payload, "base64")
  return bytes.byteLength <= maxBytes && bytes.toString("base64") === payload ? Uint8Array.from(bytes) : undefined
}

export function reference(data: string, filename: string | undefined): (mediaType: string) => Content.BlobReferencePart
export function reference(mediaType: string, data: string, filename: string | undefined): Content.BlobReferencePart
export function reference(
  mediaTypeOrData: string,
  dataOrFilename?: string,
  filename?: string,
): Content.BlobReferencePart | ((mediaType: string) => Content.BlobReferencePart) {
  if (arguments.length === 2) return (mediaType) => reference(mediaType, mediaTypeOrData, dataOrFilename)
  const mediaType = mediaTypeOrData
  const data = dataOrFilename as string
  return {
    type: "blob-reference",
    uri: `data:${mediaType};base64,${data}`,
    media_type: mediaType,
    ...(filename === undefined ? {} : { filename }),
  }
}

export const layer = Layer.succeed(
  BlobStore.Service,
  BlobStore.Service.of({
    resolve: (part) => {
      if (!part.uri.startsWith("data:"))
        return Effect.succeed({
          _tag: "Url" as const,
          url: part.uri,
          mediaType: part.media_type,
          ...(part.filename === undefined ? {} : { fileName: part.filename }),
        })
      const bytes = decode(part.uri, part.media_type)
      if (bytes === undefined)
        return BlobStore.BlobNotResolvable.make({ uri: part.uri, reason: "Malformed inline blob reference" })
      return Effect.succeed({
        _tag: "Bytes" as const,
        bytes,
        mediaType: part.media_type,
        ...(part.filename === undefined ? {} : { fileName: part.filename }),
      })
    },
    put: () => BlobStore.BlobStoreError.make({ message: "Inline blob storage does not support writes" }),
  }),
)
