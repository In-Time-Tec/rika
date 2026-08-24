import type { Model, ThreadItem } from "@rika/terminal/terminal-state"
import { stdout } from "node:process"
import { renderGoodbye } from "../input/goodbye-message"

export const writeGoodbye = (model: Model): void => {
  const threadId = model.currentThreadId
  const threadTitle =
    model.currentThreadTitle ??
    (model.threads as ReadonlyArray<ThreadItem>).find((thread) => thread.id === threadId)?.title
  try {
    stdout.write(
      renderGoodbye({
        mode: model.mode,
        workspace: model.workspace,
        ...(threadId === undefined ? {} : { threadId }),
        ...(threadTitle === undefined ? {} : { threadTitle }),
      }),
    )
  } catch {
    return
  }
}
