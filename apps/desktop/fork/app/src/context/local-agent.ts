export function hasCustomAgent(items: Array<{ native?: boolean }> | undefined) {
  return (items ?? []).some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[] | undefined, name?: string) {
  const available = items ?? []
  return available.find((item) => item.name === name) ?? available.find((item) => item.name === "build") ?? available[0]
}
