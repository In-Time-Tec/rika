import { describe, expect, test } from "vitest"
import * as Socket from "effect/unstable/socket/Socket"
import { residentSocketFailure, supportsCurrentResidentCapabilities } from "../src/resident-transport"

describe("resident protocol upgrade", () => {
  test("maps an authenticated protocol rejection to the upgrade replacement path", () => {
    const failure = residentSocketFailure(
      Socket.SocketError.make({ reason: Socket.SocketCloseError.make({ code: 4403 }) }),
      false,
    )

    expect(failure).toMatchObject({
      _tag: "ResidentServiceError",
      reason: "upgrade-required",
      message: "Resident protocol upgrade required",
    })
  })

  test("rejects an accepted resident that cannot acknowledge interactive delivery", () => {
    expect(supportsCurrentResidentCapabilities(["ping", "startup-state", "interactive-ack"])).toBe(false)
    expect(supportsCurrentResidentCapabilities(["ping", "startup-state", "transcript-pages", "interactive-ack"])).toBe(
      true,
    )
  })
})
