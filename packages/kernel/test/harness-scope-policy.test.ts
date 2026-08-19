import { describe, expect, it } from "@effect/vitest"
import { HarnessEntry } from "tenetkit/harness"
import { Schema } from "effect"
import * as ScopePolicy from "@rika/kernel/harness-scope-policy"
import * as StoreLocations from "@rika/kernel/harness-store-locations"

const identity = { thread: "thread-9f2a", workspaceDigest: "a1b2c3d4" }
const isScope = Schema.is(HarnessEntry.HarnessScope)

describe("harness scope policy", () => {
  it("renders the three documented scope strings", () => {
    expect(ScopePolicy.scopeString("global", identity)).toBe("global")
    expect(ScopePolicy.scopeString("workspace", identity)).toBe("workspace:a1b2c3d4")
    expect(ScopePolicy.scopeString("thread", identity)).toBe("thread:thread-9f2a")
  })

  it("produces strings HarnessScope accepts, so a store can key on them", () => {
    for (const name of ScopePolicy.mergeOrder) expect(isScope(ScopePolicy.scopeString(name, identity))).toBe(true)
  })

  it("refuses a workspace path as a scope, because HarnessScope forbids slashes", () => {
    expect(() => ScopePolicy.scopeString("workspace", { ...identity, workspaceDigest: "/Users/ada/code" })).toThrow()
  })

  it("refuses an empty thread id", () => {
    expect(() => ScopePolicy.scopeString("thread", { ...identity, thread: "" })).toThrow()
  })

  it("scopes a subagent by the derived session Baton gives it", () => {
    expect(ScopePolicy.scopeString("thread", { ...identity, thread: "child:run-abc:inv-1" })).toBe(
      "thread:child:run-abc:inv-1",
    )
    expect(ScopePolicy.scopeString("thread", { ...identity, thread: "fanout:fan-1:lane-a" })).toBe(
      "thread:fanout:fan-1:lane-a",
    )
  })

  it("orders merge outer to inner so a thread entry wins over workspace and global", () => {
    expect(ScopePolicy.mergeOrder).toEqual(["global", "workspace", "thread"])
  })

  it("recognises its own scope strings and rejects foreign ones", () => {
    expect(ScopePolicy.scopeName("global")).toBe("global")
    expect(ScopePolicy.scopeName("workspace:a1b2c3d4")).toBe("workspace")
    expect(ScopePolicy.scopeName("thread:thread-9f2a")).toBe("thread")
    expect(ScopePolicy.scopeName("session:1")).toBeUndefined()
  })
})

describe("harness store locations", () => {
  const roots = { home: "/home/ada", workspace: "/work/repo", dataRoot: "/home/ada/.rika" }
  const path = StoreLocations.path(roots)

  it("puts each scope under its owning root", () => {
    expect(path("global")).toBe("/home/ada/.config/rika/harness/global.json")
    expect(path("workspace:a1b2c3d4")).toBe("/work/repo/.rika/harness/workspace%3Aa1b2c3d4.json")
    expect(path("thread:thread-9f2a")).toBe("/home/ada/.rika/harness/thread%3Athread-9f2a.json")
  })

  it("encodes the scope so a colon never becomes a directory separator", () => {
    expect(path("thread:thread-9f2a").split("/").at(-1)).toBe("thread%3Athread-9f2a.json")
  })

  it("refuses a scope it does not own rather than writing outside its roots", () => {
    expect(() => path("session:1")).toThrow()
  })

  it("keeps two threads apart even when one is named like a workspace digest", () => {
    // A cell chooses the scope name and never which thread, so the only way two threads could share
    // a scope is if the strings collided. The prefix is what keeps them apart.
    const one = ScopePolicy.scopeString("thread", { thread: "abc123", workspaceDigest: "w" })
    const two = ScopePolicy.scopeString("thread", { thread: "def456", workspaceDigest: "w" })
    expect(one).not.toBe(two)
    expect(ScopePolicy.scopeString("workspace", { thread: "abc123", workspaceDigest: "abc123" })).not.toBe(one)
  })
})
