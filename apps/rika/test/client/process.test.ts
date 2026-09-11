import { expect, it } from "@effect/vitest"
import { installClientSigintHandler } from "../../src/client/process"

const makeEmitter = () => {
  const listeners = new Set<() => void>()
  return {
    on: (_event: "SIGINT", listener: () => void) => listeners.add(listener),
    off: (_event: "SIGINT", listener: () => void) => listeners.delete(listener),
    emit: () => {
      for (const listener of listeners) listener()
    },
  }
}

it("installs a removable root SIGINT handler", () => {
  const emitter = makeEmitter()
  let interrupts = 0
  let signals = 0
  const remove = installClientSigintHandler({
    rootFiber: () => ({ interruptUnsafe: () => interrupts++ }),
    onSignal: () => signals++,
    process: emitter,
  })

  emitter.emit()
  expect({ interrupts, signals }).toEqual({ interrupts: 1, signals: 1 })

  remove()
  emitter.emit()
  expect({ interrupts, signals }).toEqual({ interrupts: 1, signals: 1 })
})
