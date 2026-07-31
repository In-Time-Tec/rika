import type { Input } from "../contract/operation-input-schema"

export const isReviewOperation = (input: Input): boolean => input._tag === "Review"
