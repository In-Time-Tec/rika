import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

const packageRoot = new URL("..", import.meta.url).pathname

const bootstrapProof = `
import { Effect, Redacted } from "effect"
import { testing } from "./src/host.ts"
const received = Effect.runPromise(testing.receiveBootstrap)
await Bun.sleep(20)
const response = await Bun.fetch("http://127.0.0.1:7070/.rika/bootstrap", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential: "one-time-bootstrap" }),
})
const body = await response.text()
const credential = Redacted.value(await received)
console.log(JSON.stringify({ status: response.status, body, credential }))
`

describe("executor host process", () => {
  it.effect("flushes the accepted bootstrap response and closes its one-shot listener", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.spawn(["bun", "-e", bootstrapProof], {
          cwd: packageRoot,
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
      (child) =>
        Effect.promise(() =>
          Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]),
        ).pipe(
          Effect.tap(([exitCode, stdout, stderr]) =>
            Effect.sync(() => {
              expect(stderr).toBe("")
              expect(exitCode).toBe(0)
              expect(stdout).toBe(
                '{"status":202,"body":"accepted","credential":"one-time-bootstrap"}\n',
              )
            }),
          ),
          Effect.timeout("5 seconds"),
        ),
      (child) => Effect.sync(() => child.kill()).pipe(Effect.ignore),
    ),
  )
})
