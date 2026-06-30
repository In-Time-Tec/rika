import { Schema } from "effect"
import { LineRange, Metadata, TimestampMillis } from "./common"
import { MessageId, ThreadId, TurnId } from "./ids"
import { Call, Result } from "./tool"

export const Role = Schema.Literals(["system", "user", "assistant", "tool"]).annotate({
  identifier: "Rika.MessageRole",
})
export type Role = typeof Role.Type

export interface TextPart extends Schema.Schema.Type<typeof TextPart> {}
export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.ContentPart.Text" })

export interface ImagePart extends Schema.Schema.Type<typeof ImagePart> {}
export const ImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: Schema.String,
  data: Schema.String,
  filename: Schema.optional(Schema.String),
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.ContentPart.Image" })

export interface FileReferencePart extends Schema.Schema.Type<typeof FileReferencePart> {}
export const FileReferencePart = Schema.Struct({
  type: Schema.Literal("file-reference"),
  path: Schema.String,
  range: Schema.optional(LineRange),
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.ContentPart.FileReference" })

export interface ToolCallPart extends Schema.Schema.Type<typeof ToolCallPart> {}
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  call: Call,
}).annotate({ identifier: "Rika.ContentPart.ToolCall" })

export interface ToolResultPart extends Schema.Schema.Type<typeof ToolResultPart> {}
export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  result: Result,
}).annotate({ identifier: "Rika.ContentPart.ToolResult" })

export type ContentPart = TextPart | ImagePart | FileReferencePart | ToolCallPart | ToolResultPart
export const ContentPart = Schema.Union([TextPart, ImagePart, FileReferencePart, ToolCallPart, ToolResultPart]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Rika.ContentPart" }),
)

export interface Message extends Schema.Schema.Type<typeof Message> {}
export const Message = Schema.Struct({
  id: MessageId,
  thread_id: ThreadId,
  turn_id: Schema.optional(TurnId),
  role: Role,
  content: Schema.Array(ContentPart),
  created_at: TimestampMillis,
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.Message" })

export const text = (value: string): TextPart => ({ type: "text", text: value })
export const image = (input: Omit<ImagePart, "type">): ImagePart => ({ type: "image", ...input })
export const displayText = (message: Pick<Message, "content">): string =>
  message.content
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "image") return imageLabel(part)
      return ""
    })
    .join("")

const imageLabel = (part: ImagePart): string => {
  const label = part.metadata?.label
  return typeof label === "string" && label.length > 0 ? label : "[Image]"
}

export const user = (
  input: Omit<Message, "role" | "content"> & { readonly content: string | ReadonlyArray<ContentPart> },
) => ({
  ...input,
  role: "user" as const,
  content: typeof input.content === "string" ? [text(input.content)] : input.content,
})
export const assistant = (input: Omit<Message, "role">): Message => ({ ...input, role: "assistant" })
