import type { Input } from "../contract/product-operation"

export const isThreadOperation = (input: Input): boolean => input._tag === "Thread"
