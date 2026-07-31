import { Effect, Layer } from "effect"
import { Tokenizer } from "effect/unstable/ai"
import type { Prompt } from "effect/unstable/ai"

const charactersPerToken = 3

export const estimateTokens = (prompt: Prompt.Prompt): number =>
  Math.max(1, Math.ceil(JSON.stringify(prompt.content).length / charactersPerToken))

export const layer: Layer.Layer<Tokenizer.Tokenizer> = Layer.succeed(
  Tokenizer.Tokenizer,
  Tokenizer.make({
    tokenize: (prompt) => Effect.sync(() => Array.from({ length: estimateTokens(prompt) }, (_, index) => index)),
  }),
)
