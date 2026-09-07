import { Function } from "effect"
import type { ImageAttachment, TranscriptItem } from "./model"

const imageItemImpl = (image: ImageAttachment, id: string): TranscriptItem => ({
  id,
  kind: "image",
  title: image.path,
  text: [image.path, image.mediaType, image.byteLength === undefined ? undefined : `${image.byteLength} B`]
    .filter((part) => part !== undefined)
    .join(" · "),
})

export const imageItem: {
  (id: string): (image: ImageAttachment) => TranscriptItem
  (image: ImageAttachment, id: string): TranscriptItem
} = Function.dual(2, imageItemImpl)
