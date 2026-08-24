import { describe, expect, test } from "vitest"
import { classifyMouseJunk } from "../../../src/presentation/terminal/keymap"
import type { Key } from "../../../src/presentation/terminal/keymap"

const key = (sequence: string, overrides: Partial<Key> = {}): Key => ({
  name: sequence,
  sequence,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
  eventType: "press",
  ...overrides,
})

describe("mouse junk classification", () => {
  test("forwards modified keys untouched", () => {
    expect(classifyMouseJunk(key("a", { ctrl: true }), 0)._tag).toBe("Forward")
    expect(classifyMouseJunk(key("a", { eventType: "release" }), 0)._tag).toBe("Forward")
  })

  test("arms the buffer on an SGR mouse prefix", () => {
    expect(classifyMouseJunk(key("<"), 0)._tag).toBe("Arm")
  })

  test("buffers digits and separators once armed", () => {
    expect(classifyMouseJunk(key("3"), 1)._tag).toBe("Buffer")
    expect(classifyMouseJunk(key(";"), 1)._tag).toBe("Buffer")
  })

  test("stops buffering past the cap so real keys are never swallowed", () => {
    expect(classifyMouseJunk(key("3"), 24)._tag).toBe("Flush")
  })

  test("drops the terminating M or m of a mouse report", () => {
    expect(classifyMouseJunk(key("M"), 3)._tag).toBe("Drop")
    expect(classifyMouseJunk(key("m"), 3)._tag).toBe("Drop")
  })

  test("flushes buffered keys when the sequence turns out not to be a mouse report", () => {
    expect(classifyMouseJunk(key("q"), 3)._tag).toBe("Flush")
  })

  test("forwards an ordinary key when nothing is buffered", () => {
    expect(classifyMouseJunk(key("q"), 0)._tag).toBe("Forward")
  })
})
