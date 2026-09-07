import assert from "node:assert/strict"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createTranscriptProjection } from "../../src/ui/transcript/projection"
import type { StoreItem } from "../../src/client/state"

export const verifyProjection = () =>
  createRoot((dispose) => {
    try {
      let bodyReads = 0
      const hidden = createTranscriptProjection(() => [
        {
          id: "hidden",
          kind: "tool",
          title: "Read hidden.ts",
          get text() {
            bodyReads += 1
            return "1: hidden source"
          },
        },
      ])
      assert.equal(hidden().length, 1)
      assert.equal(bodyReads, 0)
      const [state, setState] = createStore<{ items: StoreItem[] }>({
        items: [
          { id: "read", kind: "tool", title: "Read first.ts", text: "1: initial" },
          { id: "shell", kind: "tool", title: "bash", text: "$ check\ninitial" },
          { id: "reply", kind: "assistant", title: "Rika", text: "initial reply" },
        ],
      })
      const groups = createTranscriptProjection(() => state.items)
      const initial = groups()
      setState("items", 0, "text", "1: updated source")
      assert.equal(groups(), initial)
      const read = groups()[0]
      assert.ok(read?.kind === "tools")
      assert.equal(read.items[0]?.output, "1: updated source")
      setState("items", 0, "title", "Read renamed.ts")
      assert.equal(groups(), initial)
      assert.equal(read.items[0]?.paths[0], "renamed.ts")
      setState("items", 2, "text", "streamed reply")
      assert.equal(groups(), initial)
      setState("items", 3, { id: "new", kind: "user", title: "You", text: "follow-up" })
      assert.equal(groups()[0], initial[0])
      assert.equal(groups()[1], initial[1])
      assert.equal(groups()[2], initial[2])
      setState("items", 0, "title", "bash")
      assert.equal(groups().length, 3)
      const merged = groups()[0]
      assert.ok(merged?.kind === "tools")
      assert.equal(merged.items.length, 2)
      setState("items", (items) => items.slice(1))
      assert.equal(groups()[0]?.id, "tool:shell")
    } finally {
      dispose()
    }
  })
