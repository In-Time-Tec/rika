import { expect, test } from "vitest"
import { clientSigintMode, installClientSigintHandler } from "../src/client/client-process"

test("startup and parsed operation select the process signal owner", () => {
  expect(clientSigintMode(undefined)).toBe("root")
  expect(clientSigintMode({ _tag: "Interactive" })).toBe("child")
  expect(clientSigintMode({ _tag: "Doctor" })).toBe("root")
  expect(clientSigintMode({ _tag: "Thread" })).toBe("root")
})

test("noninteractive SIGINT interrupts the root and removal detaches the listener", () => {
  let interrupted = 0
  let observed = 0
  let mode: "root" | "child" = "root"
  const remove = installClientSigintHandler({
    inputMode: () => mode,
    rootFiber: () => ({ interruptUnsafe: () => interrupted++ }),
    onSignal: () => observed++,
  })
  process.emit("SIGINT")
  expect(interrupted).toBe(1)
  expect(observed).toBe(1)
  mode = "child"
  process.emit("SIGINT")
  expect(interrupted).toBe(1)
  expect(observed).toBe(2)
  remove()
  process.emit("SIGINT")
  expect(interrupted).toBe(1)
  expect(observed).toBe(2)
})
