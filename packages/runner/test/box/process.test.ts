import { currentExecutorPolicy } from "@rika/product/executor-policy"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { boxExecutorProcessOptions } from "../../src/box/process"

it("pins process compatibility to the current product policy", () => {
  expect(boxExecutorProcessOptions.expected).toBe(currentExecutorPolicy)
  expect(boxExecutorProcessOptions.expected).toEqual({ buildId: "rika-executor-v2@1", protocolVersion: 1 })
})

it("constructs Bun WebSocket options with the exact protocol and authorization headers", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  interface FixtureWebSocketOptions {
    readonly protocols: ReadonlyArray<string>
    readonly headers: Readonly<Record<string, string>>
  }
  let captured: { readonly url: string; readonly options: FixtureWebSocketOptions } | undefined
  class FixtureWebSocket extends EventTarget {
    constructor(url: string, options: FixtureWebSocketOptions) {
      super()
      captured = { url, options }
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FixtureWebSocket, writable: true })
  try {
    const socket = boxExecutorProcessOptions.connect("wss://rika.test/api/v2/boxes/bx_23456789/executor", "rika.v1", {
      authorization: "Bearer fixture-ticket",
    })
    expect(socket).toBeInstanceOf(FixtureWebSocket)
    expect(captured).toEqual({
      url: "wss://rika.test/api/v2/boxes/bx_23456789/executor",
      options: { protocols: ["rika.v1"], headers: { authorization: "Bearer fixture-ticket" } },
    })
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, "WebSocket")
    else Object.defineProperty(globalThis, "WebSocket", original)
  }
})
