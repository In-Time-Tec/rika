import type { Input } from "../contract/operation-input-schema"

export const isThreadOperation = (input: Input): boolean => input._tag === "Thread"
