import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import { Function } from "effect"
import type { Block } from "../schema/presentation"

type SubagentStatus = Extract<Block, { readonly _tag: "SubagentCard" }>["status"]

const subagentPhraseImpl = (name: string, status: SubagentStatus): string => {
  if (status === "queued" || status === "waiting" || status === "cancelling")
    return `${Catalog.agentDisplay(name)} ${status}`
  return Catalog.agentPhrase({ name, status })
}

export const subagentPhrase: {
  (name: string, status: SubagentStatus): string
  (status: SubagentStatus): (name: string) => string
} = Function.dual(2, subagentPhraseImpl)
