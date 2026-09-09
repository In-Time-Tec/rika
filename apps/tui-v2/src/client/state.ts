import type { ScenarioFixture, ScenarioThreadFixture } from "../scenarios/fixtures"
import type { ClientState, PendingTurn } from "./model"

type Mutable<T> = T extends readonly (infer A)[]
  ? Mutable<A>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T

export type StoreState = Mutable<ClientState>
export type StoreThread = StoreState["threads"][number]
export type StoreItem = StoreThread["items"][number]

export const clonePending = (turn: PendingTurn): StoreThread["pending"][number] => {
  const cloned: StoreThread["pending"][number] = { id: turn.id, prompt: turn.prompt }
  if (turn.images !== undefined) cloned.images = turn.images.map((image) => ({ ...image }))
  return cloned
}

const cloneThread = (thread: ScenarioThreadFixture): StoreThread => ({
  id: thread.id,
  title: thread.title,
  target: thread.target,
  activity: thread.activity,
  items: thread.items.map((item) => ({ ...item })),
  pending: thread.pending.map(clonePending),
  approval: thread.approval === null ? null : { ...thread.approval },
})

export const stateFromFixture = (fixture: ScenarioFixture): StoreState => {
  const firstThread = fixture.threads[0]
  if (firstThread === undefined) throw new Error(`Scenario ${fixture.id} has no thread`)
  return {
    scenario: fixture.id,
    selectedThreadId: firstThread.id,
    threads: fixture.threads.map(cloneThread),
    mode: "medium",
    connection: fixture.connection,
    notice: fixture.notice,
    focusedSessionId: undefined,
  }
}
