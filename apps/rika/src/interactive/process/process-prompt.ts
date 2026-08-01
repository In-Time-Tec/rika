import * as ExecutionRequest from "@rika/product/execution-request"
import { maxClientMessageBytes } from "../../resident-wire"
import { promptParts } from "@rika/terminal/terminal-session"
type PromptPart = ReturnType<ReturnType<typeof promptParts>>[number]
import { Effect, FileSystem, Function, Schema } from "effect"
const formatBytes = (bytes: number): string => {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1).replace(/\.0$/, "")} KB`
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`
}

const imageMediaType = (path: string) => {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  return "application/octet-stream"
}

export class PromptAttachmentError extends Schema.TaggedErrorClass<PromptAttachmentError>()("PromptAttachmentError", {
  index: Schema.Int,
  path: Schema.String,
  message: Schema.String,
}) {}

export const maxAttachmentBytes = 5_000_000
const maxPromptPartsBytes = maxClientMessageBytes - 65_536
const attachmentMegabytes = formatBytes

const materializePromptPartsImpl = (parts: ReadonlyArray<PromptPart>, workspace: string) =>
  Effect.forEach(
    parts,
    (part, index): Effect.Effect<ExecutionRequest.PromptPart, PromptAttachmentError, FileSystem.FileSystem> => {
      if (part.type === "text") return Effect.succeed(part)
      const path = part.path.startsWith("/") ? part.path : `${workspace}/${part.path}`
      const failure = (cause: unknown) =>
        PromptAttachmentError.make({
          index,
          path: part.path,
          message: `Image attachment could not be read: ${String(cause)}`,
        })
      return FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          Effect.all([fileSystem.stat(path), fileSystem.readFile(path)]).pipe(Effect.mapError(failure)),
        ),
        Effect.flatMap(([info, bytes]) => {
          if (info.type !== "File" || bytes.byteLength === 0)
            return Effect.fail(
              PromptAttachmentError.make({
                index,
                path: part.path,
                message: `Image attachment is missing or empty: ${part.path}`,
              }),
            )
          if (bytes.byteLength > maxAttachmentBytes)
            return Effect.fail(
              PromptAttachmentError.make({
                index,
                path: part.path,
                message: `Image attachment is too large (${attachmentMegabytes(bytes.byteLength)}; the limit is ${attachmentMegabytes(maxAttachmentBytes)}): ${part.path}`,
              }),
            )
          return Effect.succeed({ mediaType: imageMediaType(path), bytes })
        }),
        Effect.flatMap(({ mediaType, bytes }) =>
          !mediaType.startsWith("image/")
            ? Effect.fail(
                PromptAttachmentError.make({
                  index,
                  path: part.path,
                  message: `Unsupported image attachment: ${part.path}`,
                }),
              )
            : Effect.succeed({
                type: "image" as const,
                mediaType,
                data: Buffer.from(bytes).toString("base64"),
                filename: part.path,
              }),
        ),
      )
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap((materialized) => {
      const images = materialized.flatMap((part, index) =>
        part.type === "image" ? [{ index, bytes: part.data.length }] : [],
      )
      const total = images.reduce((sum, image) => sum + image.bytes, 0)
      if (total <= maxPromptPartsBytes) return Effect.succeed(materialized)
      const largest = images.reduce((left, right) => (right.bytes > left.bytes ? right : left))
      const largestPart = parts[largest.index]
      return Effect.fail(
        PromptAttachmentError.make({
          index: largest.index,
          path: largestPart !== undefined && largestPart.type === "image" ? largestPart.path : "",
          message: "Image attachments exceed the 16 MiB prompt limit; remove an image and try again",
        }),
      )
    }),
  )

export const materializePromptParts: {
  (workspace: string): (parts: ReadonlyArray<PromptPart>) => ReturnType<typeof materializePromptPartsImpl>
  (parts: ReadonlyArray<PromptPart>, workspace: string): ReturnType<typeof materializePromptPartsImpl>
} = Function.dual(2, materializePromptPartsImpl)
