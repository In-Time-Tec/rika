export interface ProcessRow {
  readonly pid: number
  readonly parentPid: number
  readonly rssKibibytes: number
}

export const parse = (text: string): ReadonlyArray<ProcessRow> =>
  text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line)
    if (match === null) return []
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), rssKibibytes: Number(match[3]) }]
  })

export const rssBytes = (input: { readonly rows: ReadonlyArray<ProcessRow>; readonly rootPid: number }): number => {
  const { rows, rootPid } = input
  const descendants = new Set([rootPid])
  let found = true
  while (found) {
    found = false
    for (const row of rows) {
      if (!descendants.has(row.parentPid) || descendants.has(row.pid)) continue
      descendants.add(row.pid)
      found = true
    }
  }
  return rows.filter((row) => descendants.has(row.pid)).reduce((sum, row) => sum + row.rssKibibytes * 1024, 0)
}

export const sample = (rootPid = process.pid): number | undefined => {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="])
  if (result.exitCode !== 0) return undefined
  return rssBytes({ rows: parse(result.stdout.toString()), rootPid })
}
