// Rika interactive session attachment for the desktop renderer (M3 Phase A).
// Runs an interactive feed on a thread (or the latest thread) and hands the
// attached InteractiveSession to the caller, who dispatches the Rika event
// stream (ThreadViewSnapshot / ThreadViewPatch / InteractiveEvents). Phase B
// translates those into the opencode-shaped events the global-sync reducers
// consume.
import { Effect } from "effect"
import type { Connection } from "@rika/product/server-service"
import type { InteractiveSession } from "@rika/product/interactive-session"

export type ThreadFeedHandler = (
  session: InteractiveSession,
) => Effect.Effect<void, unknown>

/** Attach an interactive session to a thread and run its feed until closed. */
export const runThreadFeed = (
  connection: Connection,
  options: { readonly threadId?: string; readonly workspace?: string },
  handler: ThreadFeedHandler,
): Effect.Effect<void, unknown> =>
  connection.run(
    {
      _tag: "Interactive",
      prompt: [],
      ephemeral: false,
      clientWorkspace: options.workspace,
      workspace: options.workspace,
      threadId: options.threadId,
      last: options.threadId === undefined ? true : false,
    },
    { interactive: (_input, session) => handler(session) },
  )
