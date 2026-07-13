import { expect, test } from "bun:test"
import { Effect } from "effect"
import { buildTestModelScript, parseTestModelScript, productionCompaction } from "../src/main"

test("uses production compaction defaults and route overrides", () => {
  expect(productionCompaction()).toEqual({
    contextWindow: 372_000,
    reserveTokens: 128_000,
    keepRecentTokens: 32_000,
  })
  expect(
    productionCompaction({ compaction: { contextWindow: 192_000, reserveTokens: 32_000, keepRecentTokens: 16_000 } }),
  ).toEqual({
    contextWindow: 192_000,
    reserveTokens: 32_000,
    keepRecentTokens: 16_000,
  })
})

test("parses and builds multi-part delayed TestModel turns", async () => {
  const json = JSON.stringify([
    {
      parts: [
        { type: "reasoning", text: "inspect" },
        { type: "toolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1" },
      ],
      delayMs: 25,
    },
    { parts: [{ type: "text", text: "done" }] },
  ])
  const parsed = await Effect.runPromise(parseTestModelScript(json))
  expect(parsed).toHaveLength(2)
  const built = await Effect.runPromise(buildTestModelScript(json))
  expect(built).toEqual([
    {
      _tag: "Turn",
      parts: [
        { _tag: "Reasoning", text: "inspect" },
        { _tag: "ToolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
      ],
      delay: 25,
    },
    { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
  ])
})

test("rejects malformed, empty, and unsafe scripts", async () => {
  await Promise.all(
    [
      "not json",
      "[]",
      '[{"parts":[]}]',
      '[{"parts":[{"type":"toolCall","name":4}]}]',
      '[{"parts":[{"type":"text","text":"x"}],"delayMs":-1}]',
    ].map((value) => expect(Effect.runPromise(parseTestModelScript(value))).rejects.toBeDefined()),
  )
})
