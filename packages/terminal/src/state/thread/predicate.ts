import type { ThreadItem } from "./model"

export const isThreadBusy = (status: ThreadItem["status"]): boolean => status !== "idle" && status !== "error"
