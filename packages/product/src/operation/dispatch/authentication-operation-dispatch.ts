import type { Input } from "../contract/operation-input-schema"

export const isAuthenticationOperation = (input: Input): boolean => input._tag === "Auth"
