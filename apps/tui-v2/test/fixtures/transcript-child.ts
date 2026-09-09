import { testRender } from "@opentui/solid"
import assert from "node:assert/strict"
import { createComponent, createSignal } from "solid-js"
import { Transcript, type TranscriptNavigation } from "../../src/ui/transcript"

const [focusedSessionId, setFocusedSessionId] = createSignal<string>()
const [navigation, setNavigation] = createSignal<TranscriptNavigation>()
let opened: string | undefined
let backs = 0

const screen = await testRender(
  () =>
    createComponent(Transcript, {
      items: [
        {
          id: "child-session:retained-child",
          kind: "child",
          title: "retained-child",
          text: "",
          childSessionId: "retained-child",
        },
      ],
      active: false,
      focused: true,
      animate: false,
      navigation,
      get focusedSessionId() {
        return focusedSessionId()
      },
      openChildSession: (sessionId) => {
        opened = sessionId
        setFocusedSessionId(sessionId)
      },
      backToThread: () => {
        backs += 1
        setFocusedSessionId(undefined)
      },
    }),
  { width: 80, height: 12, exitOnCtrlC: false },
)

try {
  await screen.flush()
  assert.match(screen.captureCharFrame(), /Open collaborator/)
  const child = screen.renderer.root.findDescendantById("transcript-header:child-session:retained-child")
  assert.ok(child !== undefined)
  await screen.mockMouse.click(child.x + 2, child.y)
  await screen.flush()
  opened = undefined
  setFocusedSessionId(undefined)
  setNavigation({ serial: 1, action: "next" })
  await screen.flush()
  screen.mockInput.pressKey("\r")
  await screen.flush()
  assert.equal(opened, "retained-child")
  assert.match(screen.captureCharFrame(), /Back to Thread \(Esc\)/)
  const back = screen.renderer.root.findDescendantById("transcript-back-to-thread")
  assert.ok(back !== undefined)
  await screen.mockMouse.click(back.x + 2, back.y)
  await screen.flush()
  assert.equal(backs, 1)
} finally {
  screen.renderer.destroy()
}
