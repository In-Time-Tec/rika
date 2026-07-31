export interface UsageFoldState {
  readonly revision: number
  readonly observedEvents: number
}

export const observeUsageEvent = (state: UsageFoldState): UsageFoldState => ({
  revision: state.revision + 1,
  observedEvents: state.observedEvents + 1,
})
