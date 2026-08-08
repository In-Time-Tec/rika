import { describe, expect, it } from "vitest"
import { pathContainedIn } from "../src/policy/workspace-boundary-policy"

describe("workspace boundary", () => {
  const path = {
    sep: "/",
    relative: (from: string, to: string) => {
      if (to === from) return ""
      if (to.startsWith(`${from}/`)) return to.slice(from.length + 1)
      if (from.startsWith(`${to}/`)) return `..${from.slice(to.length).replaceAll("/", "/..")}`
      return to
    },
    isAbsolute: (value: string) => value.startsWith("/"),
    resolve: (...parts: ReadonlyArray<string>) => parts.join("/").replaceAll("//", "/"),
  } as Parameters<typeof pathContainedIn>[2]

  it("accepts paths inside the workspace root", () => {
    expect(pathContainedIn("/workspace", "/workspace/src/app.ts", path)).toBe(true)
  })

  it("rejects paths that resolve outside the workspace root", () => {
    expect(pathContainedIn("/workspace", "/outside/secret.ts", path)).toBe(false)
  })
})
