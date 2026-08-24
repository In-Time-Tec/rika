export interface SigintOwnership {
  readonly rootOwns: () => boolean
  readonly acquireTui: () => () => void
}

export interface ProcessListenerTarget<Event extends string = string> {
  on(event: Event, listener: () => void): void
  off(event: Event, listener: () => void): void
}

export const makeSigintOwnership = (): SigintOwnership => {
  let tuiOwns = false
  return {
    rootOwns: () => !tuiOwns,
    acquireTui: () => {
      tuiOwns = true
      let released = false
      return () => {
        if (released) return
        released = true
        tuiOwns = false
      }
    },
  }
}

export const clientSigintOwnership = makeSigintOwnership()
