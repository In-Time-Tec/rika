import type { HostedThreadSnapshot } from "@rika/product/client-protocol"
import * as Projection from "@rika/product/execution-projection"
import { ThreadId } from "@rika/product/thread-record"
import type { ThreadViewTurn } from "@rika/product/thread-view"

export const snapshot = (turns: ReadonlyArray<ThreadViewTurn> = []): HostedThreadSnapshot => ({
  executorKind: "runner",
  view: {
    thread: {
      id: ThreadId.make("thread-1"),
      workspace: "workspace-1",
      title: "Thread",
      labels: [],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" },
      createdAt: 1,
      updatedAt: 1,
    },
    revision: 0,
    source: { projectionVersion: Projection.projectionVersion },
    turns,
    pending: [],
    hasOlder: false,
    hasNewer: false,
    usage: { state: Projection.emptyUsageState() },
  },
  pendingAuthorizations: [],
})
