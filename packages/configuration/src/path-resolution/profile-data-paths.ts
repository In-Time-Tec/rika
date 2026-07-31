const under = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.endsWith("/") ? root.slice(0, -1) : root, ...segments].join("/")

export const dataPaths = (home: string) => ({
  database: under(home, ".rika", "rika.db"),
  executionDatabase: under(home, ".rika", "execution.db"),
})

const parentDirectory = (filename: string): string => {
  const separator = filename.lastIndexOf("/")
  if (separator < 0) return "."
  if (separator === 0) return "/"
  return filename.slice(0, separator)
}

export const executionEventHistoryFor = (executionDatabase: string): string =>
  under(parentDirectory(executionDatabase), "execution-event-history")
