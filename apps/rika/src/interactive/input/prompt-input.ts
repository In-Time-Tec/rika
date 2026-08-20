import type { Model } from "@rika/terminal/terminal-state"

export const imagePasteBlockedNotice = (model: Pick<Model, "editingTurnId">): string | undefined =>
  model.editingTurnId === undefined ? undefined : "Images cannot be pasted while editing a queued prompt"
