import { describe, expect, it } from "vitest"
import * as ConfigContract from "../src/config-contract"
import { ModeId, RouteModeId, modeIds, routeModeIds } from "../src/modes"

const members = (schema: { readonly ast: { readonly types?: ReadonlyArray<{ readonly literal?: unknown }> } }) =>
  (schema.ast.types ?? []).map((type) => type.literal)

describe("modes", () => {
  it("keeps the schema and the array in step", () => {
    expect(members(ModeId as never)).toEqual([...modeIds])
    expect(members(RouteModeId as never)).toEqual([...routeModeIds])
  })

  it("adds only the test route mode", () => {
    expect(routeModeIds.filter((mode) => !(modeIds as ReadonlyArray<string>).includes(mode))).toEqual(["test"])
  })

  it("ships a default route for every mode", () => {
    expect(Object.keys(ConfigContract.defaults.modes).toSorted()).toEqual([...modeIds].toSorted())
  })
})
