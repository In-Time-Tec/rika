import { describe, expect, test } from "vitest"
import { samePartition, threadIdFromRootSession, threadPartition } from "../src/hosted/partition"

describe("Rika API v2 Thread partitions", () => {
  test("reuses one namespace and root Session identity across retries", () => {
    const input = { environment: "test", ownerId: "owner/acme", threadId: "thread-42", target: "runner" as const }
    const first = threadPartition(input)
    const retry = threadPartition(input)

    expect(samePartition(first, retry)).toBe(true)
    expect(first.actorKey).toEqual(["test", "owner/acme", "thread-42"])
    expect(first.rootSessionId).toBe("rika-v2:owner%2Facme:thread-42")
    expect(threadIdFromRootSession(first.rootSessionId)).toEqual({ ownerId: "owner/acme", threadId: "thread-42" })
  })

  test("keeps placement explicit without changing the canonical partition", () => {
    const runner = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "runner" })
    const orb = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "orb" })

    expect(runner.partition).toBe(orb.partition)
    expect(runner.rootSessionId).toBe(orb.rootSessionId)
    expect(samePartition(runner, orb)).toBe(false)
  })
})
