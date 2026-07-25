import type { ModelRegistry } from "@batonfx/core"
import { Effect, Layer } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"

const providerRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}

const withBreakpoint = <Options extends Prompt.ProviderOptions>(options: Options): Options =>
  ({
    ...options,
    anthropic: { ...providerRecord(options["anthropic"]), cacheControl: { type: "ephemeral" } },
    amazonBedrock: { ...providerRecord(options["amazonBedrock"]), cachePoint: true },
  }) as unknown as Options

const partBreakpoint = <Part extends Prompt.Part>(part: Part): Part =>
  ({ ...part, options: withBreakpoint(part.options) }) as unknown as Part

const systemBreakpoint = (message: Prompt.SystemMessage): Prompt.SystemMessage => ({
  ...message,
  options: withBreakpoint(message.options),
})

const lastAnnotatablePart = (parts: ReadonlyArray<Prompt.Part>): number => {
  for (let index = parts.length - 1; index >= 0; index -= 1)
    if (parts[index]!.type !== "tool-approval-response") return index
  return -1
}

const contentBreakpoint = (message: Prompt.UserMessage | Prompt.ToolMessage): Prompt.Message => {
  const parts: ReadonlyArray<Prompt.Part> = message.content
  const target = lastAnnotatablePart(parts)
  if (target < 0) return message
  const annotated = parts.map((part, index) => (index === target ? partBreakpoint(part) : part))
  return { ...message, content: annotated } as unknown as Prompt.Message
}

export interface CacheBreakpoints {
  readonly system: number
  readonly previous: number
  readonly tail: number
}

export const cacheBreakpoints = (messages: ReadonlyArray<Prompt.Message>): CacheBreakpoints => {
  let system = -1
  let assistant = -1
  let tail = -1
  for (let index = 0; index < messages.length; index += 1) {
    const role = messages[index]!.role
    if (role === "system") system = index
    else if (role === "assistant") assistant = index
    else tail = index
  }
  let previous = -1
  for (let index = assistant - 1; index >= 0; index -= 1) {
    const role = messages[index]!.role
    if (role === "user" || role === "tool") {
      previous = index
      break
    }
  }
  return { system, previous, tail }
}

export const annotateCacheBreakpoints = (prompt: Prompt.Prompt): Prompt.Prompt => {
  const messages = prompt.content
  const { system, previous, tail } = cacheBreakpoints(messages)
  if (system < 0 && previous < 0 && tail < 0) return prompt
  return Prompt.fromMessages(
    messages.map((message, index) => {
      if (index === system && message.role === "system") return systemBreakpoint(message)
      if ((index === previous || index === tail) && (message.role === "user" || message.role === "tool"))
        return contentBreakpoint(message)
      return message
    }),
  )
}

const annotatedOptions = (options: any) => ({
  ...options,
  prompt: annotateCacheBreakpoints(Prompt.make(options.prompt)),
})

export const promptCachingLanguageModel = (model: LanguageModel.Service): LanguageModel.Service => ({
  ...model,
  generateText: ((options: any) =>
    model.generateText(annotatedOptions(options))) as LanguageModel.Service["generateText"],
  generateObject: ((options: any) =>
    model.generateObject(annotatedOptions(options))) as LanguageModel.Service["generateObject"],
  streamText: ((options: any) => model.streamText(annotatedOptions(options))) as LanguageModel.Service["streamText"],
})

export const withPromptCaching = (registration: ModelRegistry.Registration): ModelRegistry.Registration => ({
  ...registration,
  layer: Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.pipe(Effect.map(promptCachingLanguageModel)),
  ).pipe(Layer.provideMerge(registration.layer)),
})
