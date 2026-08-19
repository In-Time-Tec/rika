import { describe, expect, it } from "vitest"
import { parsePhysicalFootprintMebibytes } from "./idle-physical-footprint"

describe("parsePhysicalFootprintMebibytes", () => {
  it("prefers the auxiliary phys_footprint byte count", () => {
    const output = `python [123]: 64-bit    Footprint: 99811928 B

Auxiliary data:
    phys_footprint: 104857600 B
    phys_footprint_peak: 209715200 B`
    expect(parsePhysicalFootprintMebibytes(output)).toBe(100)
  })

  it("accepts the summary footprint when auxiliary data is unavailable", () => {
    expect(parsePhysicalFootprintMebibytes("python [123]: 64-bit    Footprint: 52428800 B")).toBe(50)
  })

  it("accepts vmmap's human-readable physical footprint", () => {
    expect(parsePhysicalFootprintMebibytes("Physical footprint:         105.5M")).toBe(105.5)
  })

  it("rejects output without a physical footprint", () => {
    expect(parsePhysicalFootprintMebibytes("no measurement available")).toBeUndefined()
  })
})
