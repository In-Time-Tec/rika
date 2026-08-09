import { Function } from "effect"
export const projectorNames = {
  titleInvocationId: "rika.thread-title",
  runChild: "run_child",
  startChildGroup: "start_child_group",
  awaitChildGroup: "await_child_group",
} as const

export const textLimit = 8_192
export const toolTextLimit = 16_384
export const cellTextLimit = 16_384
export const cellSourceLimit = 65_536

const boundedImpl = (value: string, limit: number): string =>
  value.length <= limit ? value : `…${value.slice(value.length - limit + 1)}`

const boundedHeadImpl = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`

export const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {}

const stringImpl = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)

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
  (value: unknown, fallback: string): string
  (fallback: string): (value: unknown) => string
} = Function.dual(2, stringImpl)

export const optionalString = (value: unknown): string => stringImpl(value, "")
