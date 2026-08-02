import { describe, expect, it } from "@effect/vitest"
import * as Socket from "effect/unstable/socket/Socket"
import { residentSocketFailure } from "../src/transport/client/resident-client-reconnect"

const closeFailure = (code: number) => Socket.SocketError.make({ reason: Socket.SocketCloseError.make({ code }) })

describe("residentSocketFailure close-code mapping", () => {
  it("maps a graceful 1001 drain close to the reconnectable draining outcome", () => {
    const error = residentSocketFailure(closeFailure(1001), true)
    expect(error.reason).toBe("resident-draining")
    expect(error.message).toContain("draining")
  })

  it("keeps a 4409 handshake rejection mapped to draining", () => {
    expect(residentSocketFailure(closeFailure(4409), true).reason).toBe("resident-draining")
  })

  it("leaves a 1006 abnormal close as a reconnectable transport failure", () => {
    expect(residentSocketFailure(closeFailure(1006), true).reason).toBe("transport-failed")
  })

  it("maps a 4401 close to a foreign listener", () => {
    expect(residentSocketFailure(closeFailure(4401), true).reason).toBe("foreign-listener")
  })

  it("does not trust a bare incompatible close", () => {
    expect(residentSocketFailure(closeFailure(4406), true)).toMatchObject({
      reason: "foreign-listener",
      message: "A listener reported an unsigned resident incompatibility; stop it, then run rika again",
    })
  })

  it("treats a 1006 close before acceptance as an absent resident", () => {
    expect(residentSocketFailure(closeFailure(1006), false).reason).toBe("resident-absent")
  })
})
