import { Schema } from "effect"

export const ReviewLane = Schema.Union([
  Schema.Struct({ key: Schema.Literal("correctness"), prompt: Schema.String }),
  Schema.Struct({ key: Schema.Literal("security"), prompt: Schema.String }),
  Schema.Struct({ key: Schema.Literal("quality"), prompt: Schema.String }),
])
export type ReviewLane = typeof ReviewLane.Type

export const ReviewIntent = Schema.TaggedStruct("Review", {
  lanes: Schema.Tuple([ReviewLane, ReviewLane, ReviewLane]),
  concurrency: Schema.Literal(3),
  completion: Schema.Literal("wait-for-all"),
})
export type ReviewIntent = typeof ReviewIntent.Type
