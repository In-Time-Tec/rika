import { Function } from "effect"
import type { Block, Presentation } from "../schema/presentation"

type SubagentStatus = Extract<Block, { readonly _tag: "SubagentCard" }>["status"]
export type AgentStatus = "running" | "complete" | "failed" | "cancelled"
export interface AgentPhrase {
  readonly name: string
  readonly status: AgentStatus
}

const agentPresentation = (action: string, activeLabel: string, completeLabel: string): Presentation => ({
  family: "agent",
  action,
  activeLabel,
  completeLabel,
})

const genericAgentNames = new Set(["", "child", "task", "subagent"])
const agentPresentations = {
  task: agentPresentation("task", "Subagent working", "Subagent finished"),
  oracle: agentPresentation("oracle", "Oracle exploring", "Oracle has spoken"),
  librarian: agentPresentation("librarian", "Librarian researching", "Librarian researched"),
  surgeon: agentPresentation("surgeon", "Surgeon operating", "Surgeon closed up"),
} satisfies Readonly<Record<string, Presentation>>

const agentToolName = (profile: string): string => {
  if (genericAgentNames.has(profile)) return "task"
  return profile
}

export const agentProfile = (name: string): string =>
  name
    .trim()
    .replace(/^rika-/, "")
    .replace(/:\d+$/, "")
    .trim()

export const agentDisplay = (name: string): string => {
  const profile = agentProfile(name)
  return genericAgentNames.has(profile.toLowerCase()) ? "Subagent" : profile.charAt(0).toUpperCase() + profile.slice(1)
}

export const resolveAgentPresentation = (name: string): Presentation => {
  const profile = agentProfile(name).toLowerCase()
  const toolName = agentToolName(profile)
  const defined = Object.entries(agentPresentations).find(([presentationName]) => presentationName === toolName)?.[1]
  if (defined !== undefined) return defined
  const display = agentDisplay(name)
  return agentPresentation(profile, `${display} working`, `${display} finished`)
}

export const agentPhrase = ({ name, status }: AgentPhrase): string => {
  const presentation = resolveAgentPresentation(name)
  if (status === "running") return presentation.activeLabel
  if (status === "complete") return presentation.completeLabel
  return `${agentDisplay(name)} ${status}`
}

const subagentPhraseImpl = (name: string, status: SubagentStatus): string => {
  if (status === "queued" || status === "waiting" || status === "cancelling") return `${agentDisplay(name)} ${status}`
  return agentPhrase({ name, status })
}

export const subagentPhrase: {
  (name: string, status: SubagentStatus): string
  (status: SubagentStatus): (name: string) => string
} = Function.dual(2, subagentPhraseImpl)
