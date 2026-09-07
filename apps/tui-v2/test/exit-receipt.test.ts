import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { homedir } from "node:os"
import { createClient } from "../src/client/runtime"
import { captureExitReceipt, renderExitReceipt } from "../src/exit-receipt"

it.effect("captures the selected thread before archive and disposal", () =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createClient({ scenario: "conversation" })),
      (value) => value.dispose,
    )
    const receipt = captureExitReceipt(client.state, "/workspace/rika")
    client.archiveThread()
    yield* client.dispose
    expect(receipt).toEqual({
      title: "Refactor the release command",
      workspace: "/workspace/rika",
      mode: "medium",
      scenario: "conversation",
    })
  }),
)

it("renders the compact orb, aligned details, and truthful offline relaunch command", () => {
  const rendered = renderExitReceipt({
    title: "Review transcript",
    workspace: `${homedir()}/projects/rika`,
    mode: "medium",
    scenario: "conversation",
  })
  const plain = Bun.stripANSI(rendered)
  const lines = plain.split("\n")
  expect(lines[2]).toBe(`${"   *##%%#+--".padEnd(17)}Review transcript`)
  expect(lines[3]).toBe(`${"  *#%##%@*=.:".padEnd(17)}~/projects/rika`)
  expect(plain).toContain("Offline demo — relaunch scenario (not a saved session):")
  expect(plain.endsWith("bun run tui-v2 --scenario conversation")).toBe(true)
  expect(plain).not.toContain("thread continue")
  expect(rendered).toContain("\x1b[38;2;")
})

it("keeps terminal control characters in titles and workspace paths out of the receipt", () => {
  const plain = Bun.stripANSI(
    renderExitReceipt({
      title: "Thread\n\x1b[2Jtitle",
      workspace: "/workspace/\rtitle\x07",
      mode: "high",
      scenario: "welcome",
    }),
  )
  expect(plain).toContain("Thread  [2Jtitle")
  expect(plain).toContain("/workspace/ title ")
})
