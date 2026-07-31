import { describe, expect, it, layer as provideLayer } from "@effect/vitest"
import { Effect } from "effect"
import { Prompt, Tokenizer } from "effect/unstable/ai"
import { estimateTokens, layer } from "../src/context-tokenizer"

const prompt = (text: string) => Prompt.make(text)

describe("context tokenizer", () => {
  it("estimates roughly one token per three characters of serialized content", () => {
    const text = "hello world".repeat(100)
    const estimated = estimateTokens(prompt(text))
    expect(estimated).toBeGreaterThan(text.length / 4)
    expect(estimated).toBeLessThan(text.length / 2)
    expect(estimateTokens(prompt("hi"))).toBeLessThan(100)
  })

  it("counts more tokens than the chars-over-four fallback would", () => {
    const text = "a".repeat(4_000)
    const estimated = estimateTokens(prompt(text))
    expect(estimated).toBeGreaterThan(1_000)
  })

  provideLayer(layer)((layerIt) =>
    layerIt.effect("provides a Tokenizer whose token count matches the estimate", () =>
      Effect.gen(function* () {
        const tokenizer = yield* Tokenizer.Tokenizer
        const input = prompt("estimate me precisely please")
        const tokens = yield* tokenizer.tokenize(input)
        expect(tokens.length).toBe(estimateTokens(input))
      }),
    ),
  )
})
