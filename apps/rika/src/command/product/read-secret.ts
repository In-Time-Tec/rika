import { Effect, Option } from "effect"
import { Writable } from "node:stream"
import { createInterface } from "node:readline"

export const readSecret = (prompt: string) =>
  Effect.callback<Option.Option<string>>((resume) => {
    process.stderr.write(prompt)
    const output = new Writable({ write: (_chunk, _encoding, callback) => callback() })
    const readline = createInterface({ input: process.stdin, output, terminal: true })
    readline.question("", (answer) => {
      readline.close()
      process.stderr.write("\n")
      const value = answer.trim()
      resume(Effect.succeed(value.length === 0 ? Option.none() : Option.some(value)))
    })
  })
