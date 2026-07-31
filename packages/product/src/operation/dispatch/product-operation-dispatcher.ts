import type { Input } from "../contract/operation-input-schema"

export const isProductOperation = (input: Input): boolean => input._tag === "Doctor" || input._tag === "ToolCatalog"
