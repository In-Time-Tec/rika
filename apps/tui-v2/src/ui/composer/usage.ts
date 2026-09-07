import type { ThreadView } from "../../client/model"

export const contextPercent = (thread: ThreadView | undefined): number => Math.min(99, (thread?.items.length ?? 0) * 7)
