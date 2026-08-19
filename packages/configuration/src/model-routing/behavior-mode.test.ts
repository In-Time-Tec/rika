import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import * as SettingsDefaults from "../settings/configuration-defaults"
import { ModeId } from "./behavior-mode"

describe("modes", () => {
  it("accepts custom non-empty mode names", () => {
    expect(Schema.decodeUnknownSync(ModeId)("deep-review")).toBe("deep-review")
    expect(() => Schema.decodeUnknownSync(ModeId)("")).toThrow()
  })

  it("ships a valid configurable default mode", () => {
    expect(SettingsDefaults.defaults.modes[SettingsDefaults.defaults.defaultMode]).toBeDefined()
  })
})
