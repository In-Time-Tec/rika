import type { LanguageModel } from "effect/unstable/ai"
import { Prompt } from "effect/unstable/ai"
import * as DataBlobStore from "./data-blob-store"

const part = (value: Prompt.Part): Prompt.Part => {
  if (value.type !== "file" || typeof value.data !== "string") return value
  const bytes = DataBlobStore.decode(value.data, value.mediaType)
  return bytes === undefined ? value : { ...value, data: bytes }
}

const message = (value: Prompt.Message): Prompt.Message => {
  if (!Array.isArray(value.content)) return value
  return { ...value, content: value.content.map(part) } as Prompt.Message
}

const prompt = (input: Prompt.RawInput): Prompt.Prompt => {
  const value = Prompt.make(input)
  return Prompt.fromMessages(value.content.map(message))
}

const options = <A extends { readonly prompt: Prompt.RawInput }>(value: A): A => ({
  ...value,
  prompt: prompt(value.prompt),
})

export const make = (model: LanguageModel.Service): LanguageModel.Service => ({
  ...model,
  generateText: ((input: any) => model.generateText(options(input))) as LanguageModel.Service["generateText"],
  generateObject: ((input: any) => model.generateObject(options(input))) as LanguageModel.Service["generateObject"],
  streamText: ((input: any) => model.streamText(options(input))) as LanguageModel.Service["streamText"],
})
