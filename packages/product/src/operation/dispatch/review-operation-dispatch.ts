import type { Input } from "../contract/product-operation"

export const isReviewOperation = (input: Input): boolean => input._tag === "Review"
