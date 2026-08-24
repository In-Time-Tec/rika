import { describe, expect, it } from "@effect/vitest"
import { decodeScopedIdentity, identityKey, scopedIdentity } from "../../src/ordering/unit-identity"

describe("unit identity", () => {
  it("uses compact golden encodings", () => {
    expect(identityKey("event", "run", 1)).toBe("event:run:%n1")
    expect(identityKey("tool:result", "a:b", "%n1")).toBe("tool%3Aresult:a%3Ab:%25n1")
    expect(identityKey("", "", 0, -0)).toBe("::%n0:%n-0")
    expect(scopedIdentity("thread:one", "%n1")).toBe("thread%3Aone:%25n1")
  })

  it("encodes every supported number canonically and preserves its type", () => {
    expect([
      identityKey("event", 1),
      identityKey("event", "1"),
      identityKey("event", 0),
      identityKey("event", -0),
      identityKey("event", Number.NaN),
      identityKey("event", Number.POSITIVE_INFINITY),
      identityKey("event", Number.NEGATIVE_INFINITY),
      identityKey("event", Number.MAX_SAFE_INTEGER),
      identityKey("event", Number.MIN_SAFE_INTEGER),
    ]).toEqual([
      "event:%n1",
      "event:1",
      "event:%n0",
      "event:%n-0",
      "event:%nNaN",
      "event:%nInfinity",
      "event:%n-Infinity",
      "event:%n9007199254740991",
      "event:%n-9007199254740991",
    ])
    expect(identityKey("event", 1, "1")).not.toBe(identityKey("event", "1", 1))
  })

  it("keeps family, tuple, separator, and escape boundaries injective", () => {
    const keys = [
      identityKey("event", "a:b", "c"),
      identityKey("event", "a", "b:c"),
      identityKey("event:a", "b", "c"),
      identityKey("event", "%3A", ":"),
      identityKey("event", "%", "3A:"),
      identityKey("event", "", "prefix"),
      identityKey("event", "prefix", ""),
      identityKey("event", "%n1"),
      identityKey("event", 1),
    ]

    expect(new Set(keys)).toHaveLength(keys.length)
  })

  it("round-trips scoped identities across the full supported string domain", () => {
    for (const [scope, id] of [
      ["", ""],
      [":", "%"],
      ["%n", "%3A"],
      ["line\nfeed", "nul\0byte"],
      ["😀", "工具"],
      ["e\u0301", "é"],
    ] as const)
      expect(decodeScopedIdentity(scopedIdentity(scope, id))).toEqual({ scope, id })
  })

  it("rejects malformed, unknown, and noncanonical scoped encodings", () => {
    for (const value of [
      "missing",
      "too:many:parts",
      "%:id",
      "%2:id",
      "%zz:id",
      "%3a:id",
      "%41:id",
      "scope:%n",
      "scope:%253a%",
    ])
      expect(decodeScopedIdentity(value), value).toBeUndefined()
  })
})
