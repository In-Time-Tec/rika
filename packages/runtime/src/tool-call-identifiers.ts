import { Function } from "effect"
import { Prompt, Response } from "effect/unstable/ai"

const toolCallPrefix = (namespace: string) => `rika:${encodeURIComponent(namespace)}:`
const executionNamespacePrefixes = ["execution:", "child:", "workflow:"]

export const isExecutionNamespace = (value: string) =>
  executionNamespacePrefixes.some((prefix) => value.startsWith(prefix))

export const durableToolCallId: {
  (id: string): (namespace: string) => string
  (namespace: string, id: string): string
} = Function.dual(2, (namespace: string, id: string) => {
  const prefix = toolCallPrefix(namespace)
  return id.startsWith(prefix) ? id : `${prefix}${id}`
})

const durableToolCallPrefix = (id: string) => {
  const match = /^rika:([^:]+):/.exec(id)
  if (match === null) return undefined
  try {
    const namespace = decodeURIComponent(match[1]!)
    return isExecutionNamespace(namespace) ? match[0] : undefined
  } catch {
    return undefined
  }
}

const providerToolCallId = (namespace: string, id: string) => {
  const currentPrefix = toolCallPrefix(namespace)
  if (id.startsWith(currentPrefix)) return id.slice(currentPrefix.length)
  const durablePrefix = durableToolCallPrefix(id)
  return durablePrefix === undefined ? id : id.slice(durablePrefix.length)
}

const providerPromptPart = (namespace: string, part: Prompt.Part): Prompt.Part => {
  if (part.type === "tool-call" || part.type === "tool-result")
    return { ...part, id: providerToolCallId(namespace, part.id) }
  if (part.type === "tool-approval-request")
    return { ...part, toolCallId: providerToolCallId(namespace, part.toolCallId) }
  return part
}

export const providerPrompt: {
  (input: Prompt.RawInput): (namespace: string) => Prompt.Prompt
  (namespace: string, input: Prompt.RawInput): Prompt.Prompt
} = Function.dual(2, (namespace: string, input: Prompt.RawInput) => {
  const prompt = Prompt.make(input)
  return Prompt.fromMessages(
    prompt.content.map((message) =>
      typeof message.content === "string"
        ? message
        : (Object.assign({}, message, {
            content: message.content.map((part) => providerPromptPart(namespace, part)),
          }) as Prompt.Message),
    ),
  )
})

export const durableResponsePart: {
  <A extends Response.AnyPart>(part: A): (namespace: string) => A
  <A extends Response.AnyPart>(namespace: string, part: A): A
} = Function.dual(2, <A extends Response.AnyPart>(namespace: string, part: A): A => {
  if (
    part.type === "tool-params-start" ||
    part.type === "tool-params-delta" ||
    part.type === "tool-params-end" ||
    part.type === "tool-call" ||
    part.type === "tool-result"
  )
    return { ...part, id: durableToolCallId(namespace, part.id) } as A
  if (part.type === "tool-approval-request")
    return { ...part, toolCallId: durableToolCallId(namespace, part.toolCallId) } as A
  return part
})
