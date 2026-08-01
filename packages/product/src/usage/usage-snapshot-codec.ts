import { Result } from "effect"
import type { AttemptCost, AttemptPricing, AttemptTokens } from "./usage-attempt"
import type { ActiveEvent, DeliveryIdentity } from "./usage-event"
import { ProjectionFailure } from "./usage-event"
import type { Snapshot } from "./usage-snapshot"
import type { Totals } from "./usage-total"

export const foldVersion = 6

type SerializedSnapshot = {
  readonly version: number
  readonly turns: ReadonlyArray<readonly [string, Totals]>
  readonly threads: ReadonlyArray<readonly [string, Totals]>
  readonly global: Totals
  readonly deliveries: ReadonlyArray<readonly [string, DeliveryIdentity]>
  readonly attempts: ReadonlyArray<readonly [string, AttemptCost]>
  readonly executionAttempts: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
  readonly activeEvents: ReadonlyArray<readonly [string, ActiveEvent]>
  readonly executionEvents: ReadonlyArray<readonly [string, ReadonlyArray<ActiveEvent>]>
}

export const serialize = (snapshot: Snapshot): string =>
  JSON.stringify({
    version: foldVersion,
    turns: [...snapshot.turns],
    threads: [...snapshot.threads],
    global: snapshot.global,
    deliveries: [...snapshot.deliveries],
    attempts: [...snapshot.attempts],
    executionAttempts: [...snapshot.executionAttempts].map(([key, values]) => [key, [...values]]),
    activeEvents: [...snapshot.activeEvents],
    executionEvents: [...snapshot.executionEvents],
  } satisfies SerializedSnapshot)

export const deserialize = (json: string): Result.Result<Snapshot, ProjectionFailure> => {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return Result.fail(ProjectionFailure.make({ reason: "decode-failure", message: "Snapshot is not valid JSON" }))
  }
  if (!isRecord(value) || value.version !== foldVersion)
    return Result.fail(
      ProjectionFailure.make({ reason: "unsupported-version", message: "Snapshot fold version is unsupported" }),
    )
  if (!isSerializedSnapshot(value))
    return Result.fail(
      ProjectionFailure.make({ reason: "decode-failure", message: "Snapshot has malformed nested state" }),
    )
  try {
    return Result.succeed({
      turns: new Map(value.turns),
      threads: new Map(value.threads),
      global: value.global,
      deliveries: new Map(value.deliveries),
      attempts: new Map(value.attempts),
      executionAttempts: new Map(value.executionAttempts.map(([key, values]) => [key, new Set(values)])),
      activeEvents: new Map(value.activeEvents),
      executionEvents: new Map(value.executionEvents),
    })
  } catch {
    return Result.fail(
      ProjectionFailure.make({ reason: "decode-failure", message: "Snapshot map entries are invalid" }),
    )
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === "string"
const isTuple = (value: unknown): value is readonly [unknown, unknown] => Array.isArray(value) && value.length === 2
const isEntries = (value: unknown, check: (value: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every((entry) => isTuple(entry) && isString(entry[0]) && check(entry[1]))
const isTotals = (value: unknown): value is Totals =>
  isRecord(value) &&
  ["costUsd", "pricedAttempts", "unpricedAttempts", "tokens", "countedAttempts", "uncountedAttempts"].every((key) =>
    isFiniteNumber(value[key]),
  )
const isDelivery = (value: unknown): value is DeliveryIdentity =>
  isRecord(value) &&
  isString(value.threadId) &&
  isString(value.turnId) &&
  isString(value.type) &&
  isFiniteNumber(value.createdAt) &&
  isFiniteNumber(value.sequence) &&
  isString(value.data)
const isPricing = (value: unknown): value is AttemptPricing =>
  isRecord(value) &&
  (value._tag === "Announced" ||
    (value._tag === "Priced" && isFiniteNumber(value.usd) && value.source === "provider") ||
    (value._tag === "Unpriceable" && isString(value.reason)))
const isTokens = (value: unknown): value is AttemptTokens =>
  isRecord(value) &&
  (value._tag === "Announced" ||
    (value._tag === "Counted" && isFiniteNumber(value.total)) ||
    (value._tag === "Uncounted" && isString(value.reason)))
const isAttempt = (value: unknown): value is AttemptCost =>
  isRecord(value) &&
  isString(value.threadId) &&
  isString(value.turnId) &&
  isPricing(value.cost) &&
  isTokens(value.tokens)
const activeEventTypes = new Set([
  "execution.accepted",
  "execution.started",
  "wait.created",
  "wait.woken",
  "wait.timed_out",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])
const isActiveEvent = (value: unknown): value is ActiveEvent =>
  isRecord(value) &&
  isString(value.key) &&
  isString(value.executionId) &&
  isString(value.threadId) &&
  isString(value.turnId) &&
  isString(value.type) &&
  activeEventTypes.has(value.type) &&
  isFiniteNumber(value.createdAt) &&
  isFiniteNumber(value.sequence)
const isSerializedSnapshot = (value: Readonly<Record<string, unknown>>): value is SerializedSnapshot =>
  isEntries(value.turns, isTotals) &&
  isEntries(value.threads, isTotals) &&
  isTotals(value.global) &&
  isEntries(value.deliveries, isDelivery) &&
  isEntries(value.attempts, isAttempt) &&
  isEntries(value.executionAttempts, (item) => Array.isArray(item) && item.every(isString)) &&
  isEntries(value.activeEvents, isActiveEvent) &&
  isEntries(value.executionEvents, (item) => Array.isArray(item) && item.every(isActiveEvent))
