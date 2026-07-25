import { describe, expect, it } from "vitest"
import { idFor, workflowDefinitionName, workflowDefinitionVersion } from "../src/workflow-definitions"

describe("workflow definition ids", () => {
  it("round-trips a built id back to its name", () => {
    for (const name of ["delivery", "research", "a:b"]) expect(workflowDefinitionName(String(idFor(name)))).toBe(name)
  })

  it("builds ids at the declared version", () => {
    expect(String(idFor("delivery"))).toBe(`rika:delivery:${workflowDefinitionVersion}`)
  })

  it("leaves an unrecognised id alone", () => {
    expect(workflowDefinitionName("someone-elses-id")).toBe("someone-elses-id")
  })
})
