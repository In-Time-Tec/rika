import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { homedir } from "node:os"
import { createClient } from "../src/client/runtime"
import type { ClientState } from "../src/client/model"
import { captureExitReceipt, captureOnlineExitReceipt, renderExitReceipt, type ExitReceipt } from "../src/exit-receipt"

it.effect("captures the selected thread after archive confirmation and before disposal", () =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createClient({ scenario: "conversation" })),
      (value) => value.dispose,
    )
    let receipt: ExitReceipt | undefined
    client.archiveThread(() => {
      receipt = captureExitReceipt(client.state, "/workspace/rika")
    })
    yield* client.dispose
    expect(receipt).toEqual({
      title: "Refactor the release command",
      workspace: "/workspace/rika",
      mode: "medium",
      scenario: "conversation",
    })
  }),
)

it.effect("captures the configured API and archived online Thread after confirmation", () =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createClient({ scenario: "conversation" })),
      (value) => value.dispose,
    )
    let receipt: ExitReceipt | undefined
    client.archiveThread(() => {
      receipt = captureOnlineExitReceipt(client.state, "/workspace/rika", "https://api.rika.test")
    })
    yield* client.dispose
    expect(receipt?.online).toEqual({ apiUrl: "https://api.rika.test", threadId: "conversation-runner" })
    const plain = Bun.stripANSI(receipt === undefined ? "" : renderExitReceipt(receipt))
    expect(plain).toContain("Online connection:")
    expect(plain).toContain("API: https://api.rika.test/")
    expect(plain).toContain("Thread: conversation-runner")
    expect(plain).not.toContain("Offline demo")
    expect(plain).not.toContain("thread continue")
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
  expect(plain.endsWith("bun run tui-v2 --offline --scenario conversation")).toBe(true)
  expect(plain).not.toContain("thread continue")
  expect(rendered).toContain("\x1b[38;2;")
})

it("does not claim an online Thread when the selection is empty or unknown", () => {
  const base = {
    scenario: "conversation" as const,
    threads: [],
    mode: "medium" as const,
    connection: "connected" as const,
    notice: "Connected",
    workspace: "/workspace/rika",
    previews: {},
  }
  for (const selectedThreadId of ["", "unknown-thread"]) {
    const state: ClientState = { ...base, selectedThreadId }
    const receipt = captureOnlineExitReceipt(state, "/workspace/rika", "https://api.rika.test")
    const plain = Bun.stripANSI(renderExitReceipt(receipt))
    expect(receipt.online).toEqual({ apiUrl: "https://api.rika.test" })
    expect(plain).toContain("API: https://api.rika.test/")
    expect(plain).not.toContain("Thread:")
    expect(plain).not.toContain("saved")
    expect(plain).not.toContain("thread continue")
  }
  const explicitEmpty = Bun.stripANSI(
    renderExitReceipt({
      title: "Rika",
      workspace: "/workspace/rika",
      mode: "medium",
      scenario: "conversation",
      online: { apiUrl: "https://api.rika.test", threadId: "" },
    }),
  )
  expect(explicitEmpty).not.toContain("Thread:")
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

it("keeps terminal control characters in online API and Thread labels out of the receipt", () => {
  const state: ClientState = {
    scenario: "conversation",
    selectedThreadId: "thread\r\x1b[2J",
    threads: [
      {
        id: "thread\r\x1b[2J",
        title: "Online Thread",
        target: "runner",
        activity: "idle",
        items: [],
        pending: [],
        approval: null,
      },
    ],
    mode: "medium",
    connection: "connected",
    notice: "Connected",
    workspace: "/workspace/rika",
    previews: {},
  }
  const plain = Bun.stripANSI(renderExitReceipt(captureOnlineExitReceipt(state, "/workspace/rika", "api\n\x1b[2J")))
  const api = plain.split("\n").find((line) => line.startsWith("API: "))
  const thread = plain.split("\n").find((line) => line.startsWith("Thread: "))
  expect(api).toBe("API: api  [2J")
  expect(thread).toBe("Thread: thread  [2J")
})

it("omits user information, query parameters, and fragments from online API labels", () => {
  const plain = Bun.stripANSI(
    renderExitReceipt({
      title: "Rika",
      workspace: "/workspace/rika",
      mode: "medium",
      scenario: "conversation",
      online: {
        apiUrl: "https://fixture-user:fixture-password@api.rika.test/base?token=fixture-token#fixture-fragment",
      },
    }),
  )
  expect(plain.split("\n").find((line) => line.startsWith("API: "))).toBe("API: https://api.rika.test/base")
  expect(plain).not.toContain("fixture-")
})
