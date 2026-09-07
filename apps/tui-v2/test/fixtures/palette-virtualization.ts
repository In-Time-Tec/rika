import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { ScrollBoxRenderable } from "@opentui/core"
import { testRender, useKeyboard } from "@opentui/solid"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createComponent, createSignal } from "solid-js"
import { CommandPalette } from "../../src/ui/overlays"

const regression = Effect.scoped(
  Effect.gen(function* () {
    const allEntries = Array.from({ length: 3_000 }, (_, index) => ({
      id: String(index),
      label: `Action ${index}`,
      detail: "",
      run: () => {},
    }))
    const [entries, setEntries] = createSignal(allEntries)
    const [index, setIndex] = createSignal(0)
    let chosen = ""
    const Fixture = () => {
      useKeyboard((key) => {
        if (key.name === "end") setIndex(entries().length - 1)
        if (key.name === "home") setIndex(0)
      })
      return createComponent(CommandPalette, {
        entries,
        index,
        query: () => "",
        setQuery: () => {},
        choose: (entry) => {
          chosen = entry?.id ?? ""
        },
        close: () => {},
      })
    }
    const screen = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        testRender(() => createComponent(Fixture, {}), { width: 216, height: 62, exitOnCtrlC: false }),
      ),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    yield* Effect.tryPromise(() => screen.flush())
    const list = screen.renderer.root.findDescendantById("command-palette-list")
    assert.ok(list instanceof ScrollBoxRenderable)
    const mountedRows = () =>
      list.content.getChildren().filter((child) => child.id.startsWith("command-palette-entry-"))
    assert.ok(mountedRows().length <= 32)
    assert.equal(list.scrollHeight, 3_000)
    assert.match(screen.captureCharFrame(), /Action 0\s/)
    screen.mockInput.pressKey("END")
    yield* Effect.tryPromise(() => screen.flush())
    assert.equal(index(), 2_999)
    assert.match(screen.captureCharFrame(), /Action 2999/)
    assert.ok(list.scrollTop >= 2_991)
    assert.ok(mountedRows().length <= 32)
    list.scrollTo(1_500)
    yield* Effect.tryPromise(() => screen.flush())
    const beforeWheel = list.scrollTop
    yield* Effect.tryPromise(() => screen.mockMouse.scroll(list.x + 20, list.y + 2, "down"))
    yield* Effect.tryPromise(() => screen.flush())
    assert.ok(list.scrollTop > beforeWheel)
    assert.equal(index(), 2_999)
    assert.ok(mountedRows().length <= 32)
    const firstVisible = Math.floor(list.scrollTop)
    assert.match(screen.captureCharFrame(), new RegExp(`Action ${firstVisible}\\s`))
    yield* Effect.tryPromise(() => screen.mockMouse.click(list.x + 20, list.y + 1))
    assert.equal(chosen, String(firstVisible + 1))
    screen.mockInput.pressKey("HOME")
    yield* Effect.tryPromise(() => screen.flush())
    assert.equal(list.scrollTop, 0)
    setEntries(allEntries.slice(0, 3))
    yield* Effect.tryPromise(() => screen.flush())
    assert.equal(mountedRows().length, 3)
    assert.match(screen.captureCharFrame(), /Action 2\s/)
  }),
)

BunRuntime.runMain(regression)
