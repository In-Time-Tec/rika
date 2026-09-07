import { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import assert from "node:assert/strict"
import { createComponent, createSignal } from "solid-js"
import type { TranscriptItem } from "../../src/client/model"
import { Transcript, type TranscriptNavigation } from "../../src/ui/transcript"
import { transcriptWindowSize } from "../../src/ui/transcript/window"
import { allExpandableIdsFor, defaultExpandedForId, defaultExpansionsFor } from "../../src/ui/transcript/navigation"
import { buildTranscriptGroups, type TranscriptGroup } from "../../src/ui/transcript/presenter"

const [items, setItems] = createSignal<readonly TranscriptItem[]>(
  Array.from({ length: 10_000 }, (_, index) => ({
    id: `item-${index}`,
    kind: "diff",
    title: `file-${index}.ts`,
    text: "@@ -1 +1 @@\n-before\n+after",
  })),
)
const [navigation, setNavigation] = createSignal<TranscriptNavigation>()
const screen = await testRender(
  () =>
    createComponent(Transcript, {
      get items() {
        return items()
      },
      active: false,
      animate: false,
      focused: true,
      navigation,
    }),
  { width: 100, height: 30, exitOnCtrlC: false },
)

try {
  await screen.flush()
  const scroll = screen.renderer.root.getChildren().find((child) => child instanceof ScrollBoxRenderable)
  assert.ok(scroll instanceof ScrollBoxRenderable)
  const mounted = () => scroll.content.getChildren().filter((child) => child.id.startsWith("transcript-group:"))
  const bounded = () => {
    assert.ok(mounted().length <= transcriptWindowSize)
    assert.ok(scroll.content.getChildren().length <= transcriptWindowSize + 2)
    assert.ok(scroll.scrollHeight < 1_000)
  }
  bounded()
  assert.equal(mounted().length, 250)
  assert.equal(mounted()[0]?.id, "transcript-group:item-9750")
  assert.match(screen.captureCharFrame(), /file-9999\.ts/)
  assert.equal(scroll.content.findDescendantById("transcript-newer"), undefined)

  screen.mockInput.pressKey("HOME")
  await screen.flush()
  assert.match(screen.captureCharFrame(), /Show earlier messages \(9750 groups\)/)
  const earlier = scroll.content.findDescendantById("transcript-earlier")
  assert.ok(earlier !== undefined)
  await screen.mockMouse.click(earlier.x + 2, earlier.y)
  await screen.flush()
  bounded()
  assert.equal(mounted()[0]?.id, "transcript-group:item-9500")
  assert.match(screen.captureCharFrame(), /Show newer messages/)
  const newer = scroll.content.findDescendantById("transcript-newer")
  assert.ok(newer !== undefined)
  await screen.mockMouse.click(newer.x + 2, newer.y)
  await screen.flush()
  assert.equal(mounted()[0]?.id, "transcript-group:item-9750")
  screen.mockInput.pressKey("\x1b[5~")
  await screen.flush()
  assert.equal(mounted()[0]?.id, "transcript-group:item-9500")
  screen.mockInput.pressKey("\x1b[6~")
  await screen.flush()
  assert.equal(mounted()[0]?.id, "transcript-group:item-9750")

  screen.mockInput.pressKey("HOME")
  await screen.flush()
  screen.mockInput.pressKey("HOME")
  await screen.flush()
  assert.equal(mounted()[0]?.id, "transcript-group:item-0")
  assert.equal(scroll.scrollTop, 0)
  assert.match(screen.captureCharFrame(), /file-0\.ts/)
  const positions = mounted()
    .slice(0, 4)
    .map((child) => ({ y: child.y, height: child.height }))
  for (let index = 1; index < positions.length; index += 1) {
    assert.equal(positions[index]!.y, positions[index - 1]!.y + positions[index - 1]!.height + 1)
  }
  const beforeAppend = mounted().map((child) => child.id)
  const beforeScroll = scroll.scrollTop
  setItems((previous) => [...previous, { id: "new", kind: "assistant", title: "Rika", text: "Streaming latest" }])
  await screen.flush()
  assert.deepEqual(
    mounted().map((child) => child.id),
    beforeAppend,
  )
  assert.equal(scroll.scrollTop, beforeScroll)
  bounded()

  screen.mockInput.pressKey("END")
  await screen.flush()
  assert.match(screen.captureCharFrame(), /Streaming latest/)
  assert.equal(mounted().at(-1)?.id, "transcript-group:new")
  setItems((previous) => [
    ...previous,
    { id: "newer", kind: "assistant", title: "Rika", text: "Following latest append" },
  ])
  await screen.flush()
  assert.match(screen.captureCharFrame(), /Following latest append/)
  screen.mockInput.pressKey("HOME")
  await screen.flush()
  const latestPage = mounted().map((child) => child.id)
  setItems((previous) => [
    ...previous,
    { id: "newest", kind: "assistant", title: "Rika", text: "Preserving scrolled page" },
  ])
  await screen.flush()
  assert.deepEqual(
    mounted().map((child) => child.id),
    latestPage,
  )
  assert.equal(scroll.scrollTop, 0)
  screen.mockInput.pressKey("END")
  await screen.flush()
  assert.match(screen.captureCharFrame(), /Preserving scrolled page/)
  setNavigation({ serial: 1, action: "next" })
  await screen.flush()
  assert.equal(mounted()[0]?.id, "transcript-group:item-0")
  assert.match(screen.captureCharFrame(), /file-0\.ts/)
  setNavigation({ serial: 2, action: "toggle" })
  await screen.flush()
  assert.match(screen.captureCharFrame(), /after/)
  screen.mockInput.pressKey("END")
  await screen.flush()
  setNavigation({ serial: 3, action: "previous" })
  await screen.flush()
  assert.match(screen.captureCharFrame(), /file-9999\.ts/)
  setNavigation({ serial: 4, action: "next" })
  await screen.flush()
  assert.match(screen.captureCharFrame(), /after/)
  bounded()

  let groupVisits = 0
  const stressGroups: TranscriptGroup[] = items().map((item) => ({
    get kind() {
      groupVisits += 1
      return "item" as const
    },
    id: item.id,
    item,
  }))
  assert.equal(defaultExpansionsFor(stressGroups).size, 10_000)
  assert.equal(groupVisits, stressGroups.length)
  const mixedGroups = buildTranscriptGroups([
    { id: "diff", kind: "diff", title: "source.ts", text: "+added" },
    { id: "child", kind: "child", title: "Reviewer", text: "Working", status: "working" },
    { id: "empty-child", kind: "child", title: "Reviewer", text: "" },
    { id: "edit", kind: "tool", title: "Edit source.ts", text: "+added", status: "working" },
    { id: "edit-done", kind: "tool", title: "Edit other.ts", text: "+added", status: "idle" },
  ])
  assert.deepEqual(
    [...defaultExpansionsFor(mixedGroups)],
    allExpandableIdsFor(mixedGroups).map((id) => [id, defaultExpandedForId(mixedGroups, id)]),
  )
  setNavigation({ serial: 5, action: "all" })
  await screen.flush()
  assert.equal(mounted().length, 250)
  assert.ok(mounted().every((group) => group.height > 1))
  setNavigation({ serial: 6, action: "all" })
  await screen.flush()
  assert.ok(mounted().every((group) => group.height === 1))
  bounded()

  let offscreenBodyReads = 0
  const [toolOutput, setToolOutput] = createSignal("$ check\ninitial")
  setItems((previous) => [
    ...previous,
    {
      id: "streaming-tool",
      kind: "tool",
      title: "bash",
      status: "working",
      get text() {
        offscreenBodyReads += 1
        return toolOutput()
      },
    },
  ])
  await screen.flush()
  setToolOutput("$ check\nstreamed output")
  await screen.flush()
  assert.equal(offscreenBodyReads, 0)
  assert.equal(mounted()[0]?.id, "transcript-group:item-0")
  setNavigation({ serial: 7, action: "toggle" })
  await screen.flush()
  assert.match(screen.captureCharFrame(), /after/)

  setItems(items().slice(0, 3))
  await screen.flush()
  assert.equal(mounted().length, 3)
  assert.equal(scroll.content.findDescendantById("transcript-earlier"), undefined)
  assert.equal(scroll.content.findDescendantById("transcript-newer"), undefined)
  assert.ok(screen.captureCharFrame().includes("file-2.ts"))
} finally {
  screen.renderer.destroy()
}
