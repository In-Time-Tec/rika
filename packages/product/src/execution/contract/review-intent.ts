export type ReviewLane =
  | { readonly key: "correctness"; readonly prompt: string }
  | { readonly key: "security"; readonly prompt: string }
  | { readonly key: "quality"; readonly prompt: string }

export interface ReviewIntent {
  readonly _tag: "Review"
  readonly lanes: readonly [ReviewLane, ReviewLane, ReviewLane]
  readonly concurrency: 3
  readonly completion: "wait-for-all"
}
