import { Schema } from "effect"

export const ThreadState = Schema.Literals(["idle", "error", "queued", "running"])
export type ThreadState = typeof ThreadState.Type

const ranked = [
  { rank: 2, state: "running", statuses: ["accepted", "running", "waiting", "cancelling"] },
  { rank: 1, state: "queued", statuses: ["queued"] },
] as const satisfies ReadonlyArray<{
  readonly rank: number
  readonly state: ThreadState
  readonly statuses: ReadonlyArray<string>
}>

export const statusRank = (status: string): number =>
  ranked.find((entry) => (entry.statuses as ReadonlyArray<string>).includes(status))?.rank ?? 0

export const rankCase = (column: string): string =>
  [
    "CASE",
    ...ranked.map(
      (entry) => `WHEN ${column} IN (${entry.statuses.map((status) => `'${status}'`).join(", ")}) THEN ${entry.rank}`,
    ),
    "ELSE 0 END",
  ].join(" ")

interface RankedThreadState {
  readonly rank: number
  readonly lastStatus: string | undefined
}

export const threadStateFromRank = ({ rank, lastStatus }: RankedThreadState): ThreadState =>
  ranked.find((entry) => entry.rank === rank)?.state ?? (lastStatus === "failed" ? "error" : "idle")

export const threadState = (statuses: ReadonlyArray<string>): ThreadState => {
  const rank = statuses.reduce((highest, status) => Math.max(highest, statusRank(status)), 0)
  return threadStateFromRank({ rank, lastStatus: statuses.at(-1) })
}
