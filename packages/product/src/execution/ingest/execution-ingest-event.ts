import type { Event } from "../contract/execution-event"

export const childExecutionIds = (event: Event): ReadonlyArray<string> => {
  const ids = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) ids.add(value)
  }
  add(event.childExecutionId)
  for (const key of ["child_execution_id", "child_run_id", "childId", "child_id"])
    add(event.data?.[key])
  return [...ids]
}
