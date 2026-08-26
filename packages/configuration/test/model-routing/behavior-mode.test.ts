import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import * as SettingsDefaults from "../../src/settings/defaults"
import { ModeId } from "../../src/model-routing/behavior-mode"

describe("modes", () => {
  it("accepts custom non-empty mode names", () => {
    expect(Schema.decodeSync(ModeId)("deep-review")).toBe("deep-review")
    expect(() => Schema.decodeSync(ModeId)("")).toThrow()
  })

  it("ships a valid configurable default mode", () => {
    expect(SettingsDefaults.defaults.modes[SettingsDefaults.defaults.defaultMode]).toBeDefined()
  })
})
