import type { Model } from "@rika/terminal/terminal-state"

export type FocusPanel = "composer" | "transcript" | "context"

export type Overlay = "palette" | "threads" | "exit" | "shortcuts" | "mode" | "context" | "file-picker" | "file-preview"

export type Drafts = Record<string, string>

export type DraftAttachment = Model["pastedText"][number] & {
  readonly mediaType?: string
  readonly byteLength?: number
}

export type DraftAttachments = Record<string, readonly DraftAttachment[]>

export interface TranscriptNavigation {
  readonly serial: number
  readonly action: "next" | "previous" | "toggle" | "all"
}
