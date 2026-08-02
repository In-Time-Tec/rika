import type { ThreadItem } from "./terminal-thread-state"

export const isThreadBusy = (status: ThreadItem["status"]): boolean => status !== "idle" && status !== "error"
