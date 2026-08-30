import * as TranscriptUnitOrder from "@rika/transcript/transcript-unit-order"
import type { Unit } from "@rika/transcript/transcript-unit"
import { initial, type Model } from "../../../src/state/model"
import type { ThreadItem } from "../../../src/state/thread/model"

export const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/workspace",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

const previewUnits = (turnId: string, prompt: string, answers: ReadonlyArray<string>): ReadonlyArray<Unit> => [
  {
    key: `turn:${turnId}:user`,
    turnId,
    order: TranscriptUnitOrder.unitOrder(`turn:${turnId}:user`, 0),
    revision: 0,
    content: { _tag: "Entry", role: "user", text: prompt },
  },
  ...answers.map(
    (text, index): Unit => ({
      key: `assistant:${turnId}:${index}`,
      turnId,
      order: TranscriptUnitOrder.unitOrder(`assistant:${turnId}:${index}`, index + 1),
      revision: index + 1,
      content: { _tag: "Entry", role: "assistant", text },
    }),
  ),
]

export const threadBrowser = (): Model => ({
  ...initial("/workspace", "high"),
  currentThreadId: "thread-1",
  threadSwitcher: { open: true, query: "", selected: 0, kind: "switch" },
  threads: [
    thread({
      id: "thread-1",
      title: "Rika performance and reliability",
      unread: true,
      editTotals: { added: 428, modified: 56, removed: 59 },
    }),
    thread({
      id: "thread-2",
      title: "Push all local changes to main",
      status: "running",
      editTotals: { added: 558, modified: 68, removed: 68 },
    }),
    thread({ id: "thread-3", title: "TUI performance and bug audit", unread: true }),
  ],
  threadPreview: {
    _tag: "Ready",
    value: {
      threadId: "thread-1",
      requestId: 1,
      units: previewUnits("preview", "Finish the thread UI parity work.", [
        "Merged all work into main and verified the affected paths.",
      ]),
    },
  },
})
