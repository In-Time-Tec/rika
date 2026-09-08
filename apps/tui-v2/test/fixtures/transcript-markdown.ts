import { testRender } from "@opentui/solid"
import assert from "node:assert/strict"
import { createComponent, createSignal } from "solid-js"
import type { TranscriptItem } from "../../src/client/model"
import { Transcript } from "../../src/ui/transcript"

const source =
  "**Inspect** the source.  \nKeep this hard break.\n\n- Preserve `inline code`\n- Keep the list\n\n```ts\nconst ready = true\n```\n\nA long line wraps at the available width without wrapping the already rendered markdown again."
const [items, setItems] = createSignal<readonly TranscriptItem[]>([])
const screen = await testRender(
  () =>
    createComponent(Transcript, {
      get items() {
        return items()
      },
      active: false,
      animate: false,
      focused: true,
    }),
  { width: 64, height: 32, exitOnCtrlC: false },
)

try {
  let expected: string | undefined
  for (const kind of ["assistant", "reasoning"] as const) {
    for (const size of [1, 7, source.length]) {
      setItems([])
      await screen.flush()
      for (let offset = 0; offset < source.length; offset += size) {
        const text = source.slice(0, offset + size)
        setItems([{ id: "response", kind, title: "", text, status: "working" }])
        await screen.flush()
        const frame = screen.captureCharFrame()
        if (text.includes("**Inspect**")) {
          assert.match(frame, /Inspect/)
          assert.doesNotMatch(frame, /\*\*Inspect\*\*/)
        }
        if (text.includes("Keep this hard break.")) {
          assert.match(frame, /Inspect the source\.\s*\n[^\n]*Keep this hard break\./)
        }
      }
      const streamed = screen.captureCharFrame()
      assert.doesNotMatch(streamed, /`inline code`|```ts/)
      assert.match(streamed, /const ready = true/)
      expected ??= streamed
      assert.equal(streamed, expected)
      setItems([{ id: "response", kind, title: "", text: source, status: "idle" }])
      await screen.flush()
      assert.equal(screen.captureCharFrame(), streamed)
      screen.mockInput.pressKey("HOME")
      await screen.flush()
      assert.match(screen.captureCharFrame(), /Inspect the source/)
      screen.mockInput.pressKey("END")
      await screen.flush()
      assert.equal(screen.captureCharFrame(), streamed)
    }
  }
} finally {
  screen.renderer.destroy()
}
