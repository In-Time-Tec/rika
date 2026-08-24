import { Function, Option, Schema } from "effect"
export const projectorNames = {
  titleInvocationId: "rika.thread-title",
  runChild: "run_child",
  runChildGroup: "run_child_group",
} as const

export const textLimit = 8_192
export const toolTextLimit = 16_384

const boundedImpl = (value: string, limit: number): string =>
  value.length <= limit ? value : `…${value.slice(value.length - limit + 1)}`

const boundedHeadImpl = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`

const SerializedRecord = Schema.Record(Schema.String, Schema.Json)

export const record = Function.flow(
  Schema.decodeUnknownOption(SerializedRecord),
  Option.getOrElse((): Readonly<Record<string, Schema.Json | undefined>> => ({})),
)

const decodeString = Schema.decodeUnknownOption(Schema.String)
type SerializedValue = Parameters<typeof decodeString>[0]
const stringImpl = (value: SerializedValue, fallback = ""): string =>
  Option.getOrElse(decodeString(value), () => fallback)

export const bounded: {
  (arg0: Parameters<typeof boundedImpl>[0], arg1: Parameters<typeof boundedImpl>[1]): ReturnType<typeof boundedImpl>
  (arg1: Parameters<typeof boundedImpl>[1]): (arg0: Parameters<typeof boundedImpl>[0]) => ReturnType<typeof boundedImpl>
} = Function.dual(2, boundedImpl)

export const boundedHead: {
  (
    arg0: Parameters<typeof boundedHeadImpl>[0],
    arg1: Parameters<typeof boundedHeadImpl>[1],
  ): ReturnType<typeof boundedHeadImpl>
  (
    arg1: Parameters<typeof boundedHeadImpl>[1],
  ): (arg0: Parameters<typeof boundedHeadImpl>[0]) => ReturnType<typeof boundedHeadImpl>
} = Function.dual(2, boundedHeadImpl)

export const string: {
  (value: SerializedValue, fallback: string): string
  (fallback: string): (value: SerializedValue) => string
} = Function.dual(2, stringImpl)

export const optionalString = (value: SerializedValue): string => stringImpl(value, "")
