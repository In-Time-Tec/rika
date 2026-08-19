export const queuedTurnPromoteMaxAgeMs = 86_400_000

export type PendingTurn = {
  readonly id: string
  readonly prompt: string
  readonly createdAt: number
}
