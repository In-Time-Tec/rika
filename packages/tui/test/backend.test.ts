import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import { Backend } from "../src/index"

const threadId = Ids.ThreadId.make("thread_backend_switcher")

describe("Backend thread options", () => {
  test("derive display-safe title, preview, and diff stats from thread summary data", () => {
    const option = Backend.threadOption({
      thread_id: threadId,
      title_text: "Fix switch thread preview",
      latest_message_text: '{"tool_call":{"name":"read","input":{"path":"package.json"}}}',
      updated_at: Date.now(),
      archived: false,
      diff: { additions: 3, modifications: 1, deletions: 1 },
    })

    expect(option.label).toBe("Fix switch thread preview")
    expect(option.title).toBe("Fix switch thread preview")
    expect(option.preview).toContain("Fix switch thread preview")
    expect(option.preview).not.toContain("tool_call")
    expect(option.diff).toEqual({ additions: 3, modifications: 1, deletions: 1 })
  })
})
