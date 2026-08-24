import { describe, expect, it } from "vitest"
import { kernelBinaries } from "../src/kernel-composition"

const join = (directory: string, name: string) => `${directory}/${name}`

describe("kernel binaries", () => {
  it("leaves an ordinary install on the path its own package resolves", () => {
    expect(kernelBinaries({ resolvedWorkerExists: true, executableDirectory: "/anywhere", join })).toEqual({})
  })

  it("names both the worker and the runtime a compiled host ships beside itself", () => {
    // A worker is a script and a script needs something to run it, so a host that cannot resolve its
    // own module has to supply both: naming only the worker leaves the runtime looked up on PATH.
    expect(kernelBinaries({ resolvedWorkerExists: false, executableDirectory: "/opt/rika/bin", join })).toEqual({
      workerModule: "/opt/rika/bin/.rika-kernel-worker.js",
      runtimeCommand: "/opt/rika/bin/.rika-kernel-runtime",
    })
  })
})
