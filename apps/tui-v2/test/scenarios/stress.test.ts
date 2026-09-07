import { expect, test } from "vitest"
import { createWorkload, scales } from "../../src/scenarios/stress"

test("seeds exact bounded workload counts and updates selected and background streams", () => {
  const workload = createWorkload({ items: 12, children: 4, queued: 3, threads: 2, streams: 2 })
  const selected = workload.client.state.threads[0]!
  expect(workload.client.state.threads).toHaveLength(2)
  expect(selected.items).toHaveLength(17)
  expect(selected.pending).toHaveLength(3)
  expect(workload.toolCalls).toBe(8)
  workload.advance(7)
  expect(selected.items[12]?.text).toContain("checkpoint 7")
  expect(selected.items[14]?.text).not.toContain("checkpoint 7")
  expect(selected.items[16]?.text).toContain("chunk-7-0")
  expect(workload.client.state.threads[1]?.items[0]?.text).toContain("chunk-7-1")
  expect(selected.items[0]?.text).toContain("tool output checkpoint 7")
  expect(selected.pending).toHaveLength(3)
  expect(selected.pending[0]?.id).toBe("pending-1")
  expect(selected.pending[1]?.prompt).toContain("Edited synthetic instruction")
  expect(selected.pending[2]?.id).toBe("pending-appended-7")
  workload.client.setMode("high")
  expect(workload.client.state.mode).toBe("high")
})

test("newest streaming placement updates final tool calls without changing the oldest default", () => {
  const size = { items: 12, children: 4, queued: 3, threads: 2, streams: 2 }
  const newest = createWorkload({ ...size, streamPlacement: "newest" })
  const oldest = createWorkload(size)
  newest.advance(2)
  oldest.advance(2)
  const newestItems = newest.client.state.threads[0]!.items
  const oldestItems = oldest.client.state.threads[0]!.items
  expect(newestItems[8]?.text).toContain("tool output checkpoint 2")
  expect(newestItems[9]?.text).toContain("tool output checkpoint 2")
  expect(newestItems[0]?.text).not.toContain("tool output checkpoint 2")
  expect(oldestItems[0]?.text).toContain("tool output checkpoint 2")
  expect(oldestItems[1]?.text).toContain("tool output checkpoint 2")
  expect(oldestItems[9]?.text).not.toContain("tool output checkpoint 2")
  expect(newest.streamingToolCount).toBe(oldest.streamingToolCount)
})

test("extreme scale increases history only and leaves existing presets unchanged", () => {
  expect(scales.extreme).toEqual({ items: 100_000, children: 1_000, queued: 1_000 })
  expect(scales.large).toEqual({ items: 10_000, children: 1_000, queued: 1_000 })
})
