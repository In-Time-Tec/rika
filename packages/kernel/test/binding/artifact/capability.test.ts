import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { operations } from "../../../src/binding/artifact/capability"

const getInput = operations.find((operation) => operation.name === "get")!.input

describe("artifacts", () => {
  it("takes only the identifier shape a put returns", () => {
    // The identifier names a file under the artifact directory, so a value that is not one could
    // name a path outside it.
    const accepts = (id: string) => Schema.is(getInput)({ id })
    expect(accepts("23f97c9dcdd6350b")).toBe(true)
    for (const escape of ["../../secret", "../escape", "a/b", "", "23f97c9dcdd6350bx"])
      expect(accepts(escape), escape).toBe(false)
  })
})
