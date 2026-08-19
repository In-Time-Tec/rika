import { describe, expect, it } from "@effect/vitest"
import * as Socket from "effect/unstable/socket/Socket"
import { serverSocketFailure } from "../src/transport/client/server-client-reconnect"

const closeFailure = (code: number) => Socket.SocketError.make({ reason: Socket.SocketCloseError.make({ code }) })

describe("serverSocketFailure close-code mapping", () => {
  it("maps a graceful 1001 drain close to the reconnectable draining outcome", () => {
    const error = serverSocketFailure(closeFailure(1001), true)
    expect(error.reason).toBe("server-draining")
    expect(error.message).toContain("draining")
  })

  it("keeps a 4409 handshake rejection mapped to draining", () => {
    expect(serverSocketFailure(closeFailure(4409), true).reason).toBe("server-draining")
  })

  it("leaves a 1006 abnormal close as a reconnectable transport failure", () => {
    expect(serverSocketFailure(closeFailure(1006), true).reason).toBe("transport-failed")
  })

  it("maps a 4401 close to a foreign listener", () => {
    expect(serverSocketFailure(closeFailure(4401), true).reason).toBe("foreign-listener")
  })

  it("does not trust a bare build-mismatch close", () => {
    expect(serverSocketFailure(closeFailure(4406), true)).toMatchObject({
      reason: "foreign-listener",
      message: "A listener reported an unsigned server build mismatch; stop it, then run rika again",
    })
  })

  it("treats a 1006 close before acceptance as an absent server", () => {
    expect(serverSocketFailure(closeFailure(1006), false).reason).toBe("server-absent")
  })
})
