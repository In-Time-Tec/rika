export const makeFeedFrameBatcher = <Event>(options: {
  readonly schedule: (flush: () => void) => void
  readonly apply: (events: ReadonlyArray<Event>) => void
  readonly render: () => void
}) => {
  type BatchState = { readonly _tag: "Idle" } | { readonly _tag: "Scheduled" }
  const pending: Array<Event> = []
  let state: BatchState = { _tag: "Idle" }
  const schedule = (flush: () => void) => {
    state = { _tag: "Scheduled" }
    options.schedule(flush)
  }
  const flush = () => {
    state = { _tag: "Idle" }
    if (pending.length === 0) return
    const events = pending.splice(0, 256)
    options.apply(events)
    options.render()
    if (pending.length > 0) schedule(flush)
  }
  const offer = (event: Event) => {
    pending.push(event)
    if (state._tag === "Scheduled") return
    schedule(flush)
  }
  return { offer, flush }
}
