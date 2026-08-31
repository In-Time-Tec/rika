import { Effect, Option, Redacted } from "effect"
import { Prompt } from "effect/unstable/cli"

export const readSecret = (prompt: string) =>
  Prompt.run(Prompt.hidden({ message: prompt })).pipe(
    Effect.map((secret) => Redacted.value(secret).trim()),
    Effect.map(Option.liftPredicate((value) => value.length > 0)),
  )
