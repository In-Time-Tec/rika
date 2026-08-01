import stringWidth from "string-width"
import type { Model } from "../../state/model/terminal-state"
import type { QueueItem } from "../../state/model/terminal-queue-item"

export const queueItemLabel = (item: QueueItem): string =>
  `${item.prompt}${item.attachments?.map((path) => `\n  ▧ ${path}`).join("") ?? ""}`
interface QueueHintSegment {
  readonly accent: string
  readonly suffix: string
}
export const queueNavigationHint: ReadonlyArray<QueueHintSegment> = [
  { accent: "Enter", suffix: " to steer" },
  { accent: "Backspace", suffix: " to dequeue" },
  { accent: "Ctrl+E", suffix: " to edit" },
]
export const queueEditingHint: ReadonlyArray<QueueHintSegment> = [
  { accent: "Editing queued", suffix: "" },
  { accent: "Enter", suffix: " save" },
  { accent: "Esc", suffix: " cancel" },
]
const minimumInlineQueueMessageWidth = 12
export const queueHintWidth = (segments: ReadonlyArray<QueueHintSegment>): number =>
  stringWidth(` ${segments.map((segment) => `${segment.accent}${segment.suffix}`).join(" · ")} `)
export const fittingQueueHint = (
  segments: ReadonlyArray<QueueHintSegment>,
  width: number,
): ReadonlyArray<QueueHintSegment> => {
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length)
    if (width - queueHintWidth(candidate) >= minimumInlineQueueMessageWidth) return candidate
  }
  return []
}
export const displayCursorOffset = (model: Model): number => {
  let offset = model.cursor
  for (const attachment of model.pastedText) {
    const tokenOffset = model.input.indexOf(attachment.token)
    if (tokenOffset >= 0 && tokenOffset < model.cursor) offset += attachment.label.length - attachment.token.length
  }
  return offset
}
