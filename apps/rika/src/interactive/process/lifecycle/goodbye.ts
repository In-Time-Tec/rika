import type { Model } from "@rika/terminal/terminal-state"
import { stdout } from "node:process"
import { renderGoodbye } from "../../input/goodbye"

export const writeGoodbye = (model: Model): void => {
  const threadId = model.currentThreadId
  const threadTitle = model.currentThreadTitle ?? model.threads.find((thread) => thread.id === threadId)?.title
  try {
    const input = { mode: model.mode, workspace: model.workspace }
    if (threadId !== undefined) Object.assign(input, { threadId })
    if (threadTitle !== undefined) Object.assign(input, { threadTitle })
    stdout.write(renderGoodbye(input))
  } catch {
    return
  }
}
