import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createComponent } from "solid-js"
import type { TranscriptItem } from "../../src/client/model"
import { Transcript } from "../../src/ui/transcript"
import { statusGlyph } from "../../src/ui/transcript/content"

const regression = Effect.scoped(
  Effect.gen(function* () {
    const items: TranscriptItem[] = [
      { id: "first", kind: "tool", title: "Run first", text: "", status: "working" },
      ...Array.from(
        { length: 40 },
        (_, index): TranscriptItem => ({
          id: `middle-${index}`,
          kind: "notice",
          title: "Notice",
          text: `Intervening notice ${index}`,
        }),
      ),
      { id: "last", kind: "tool", title: "Run last", text: "", status: "working" },
    ]
    const screen = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        testRender(() => createComponent(Transcript, { items, active: true, animate: true, focused: true }), {
          width: 100,
          height: 12,
          exitOnCtrlC: false,
        }),
      ),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    yield* Effect.tryPromise(() => screen.flush())
    const scroll = screen.renderer.root.getChildren().find((node) => node instanceof ScrollBoxRenderable)
    assert.ok(scroll instanceof ScrollBoxRenderable)
    const header = (id: string) => {
      const group = scroll.content.findDescendantById(`transcript-group:tool:${id}`)
      const text = group?.getChildren()[0]?.getChildren()[0]
      assert.ok(text instanceof TextRenderable)
      return text
    }
    const first = header("first")
    const last = header("last")
    const frameZero = statusGlyph("working", 0, true)
    yield* Effect.sleep(120)
    yield* Effect.tryPromise(() => screen.flush())
    assert.ok(first.y + first.height <= scroll.viewport.y)
    assert.ok(last.y >= scroll.viewport.y)
    assert.ok(last.y < scroll.viewport.y + scroll.viewport.height)
    assert.ok(first.plainText.startsWith(frameZero))
    const bottomBefore = last.plainText
    yield* Effect.sleep(120)
    yield* Effect.tryPromise(() => screen.flush())
    assert.notEqual(last.plainText, bottomBefore)
    assert.ok(first.plainText.startsWith(frameZero))

    screen.mockInput.pressKey("HOME")
    yield* Effect.tryPromise(() => screen.flush())
    yield* Effect.sleep(120)
    yield* Effect.tryPromise(() => screen.flush())
    assert.equal(scroll.scrollTop, 0)
    assert.ok(first.y >= scroll.viewport.y)
    assert.ok(first.y < scroll.viewport.y + scroll.viewport.height)
    assert.ok(last.y >= scroll.viewport.y + scroll.viewport.height)
    assert.ok(last.plainText.startsWith(frameZero))
    const topBefore = first.plainText
    yield* Effect.sleep(120)
    yield* Effect.tryPromise(() => screen.flush())
    assert.notEqual(first.plainText, topBefore)
    assert.ok(last.plainText.startsWith(frameZero))
  }),
)

BunRuntime.runMain(regression)
