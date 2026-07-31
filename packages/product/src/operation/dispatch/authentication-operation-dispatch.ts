import type { Input } from "../contract/product-operation"

export const isAuthenticationOperation = (input: Input): boolean => input._tag === "Auth"
