import type { Input } from "../contract/product"

export const isProductOperation = (input: Input): boolean => input._tag === "Doctor" || input._tag === "ToolCatalog"
