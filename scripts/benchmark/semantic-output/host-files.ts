const normalize = (value: string): string => {
  const absolute = value.startsWith("/")
  const segments: Array<string> = []
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === ".") continue
    if (segment === "..") segments.pop()
    else segments.push(segment)
  }
  return `${absolute ? "/" : ""}${segments.join("/")}`
}

const join = (...parts: ReadonlyArray<string>): string => normalize(parts.join("/"))
const resolve = (value: string): string => normalize(value.startsWith("/") ? value : `${process.cwd()}/${value}`)
const dirname = (value: string): string => value.slice(0, Math.max(1, value.lastIndexOf("/")))

const spawn = (command: ReadonlyArray<string>, input?: string) => {
  const result = Bun.spawnSync([...command], {
    ...(input === undefined ? {} : { stdin: new Blob([input]) }),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")} failed (${result.exitCode})\n${result.stderr.toString()}`)
  return result.stdout.toString()
}

export const HostFiles = {
  join,
  resolve,
  dirname,
  exists: (path: string): boolean => Bun.spawnSync(["test", "-e", path]).exitCode === 0,
  mkdir: (path: string): void => void spawn(["mkdir", "-p", path]),
  remove: (path: string): void => void spawn(["rm", "-rf", path]),
  read: (path: string): string => spawn(["cat", path]),
  bytes: (path: string): Uint8Array => {
    const result = Bun.spawnSync(["cat", path], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`cat ${path} failed (${result.exitCode})\n${result.stderr.toString()}`)
    return result.stdout
  },
  write: (path: string, content: string): void => {
    void spawn(["mkdir", "-p", dirname(path)])
    void spawn(["tee", path], content)
  },
  copy: (source: string, destination: string): void => {
    void spawn(["mkdir", "-p", dirname(destination)])
    void spawn(["cp", source, destination])
  },
} as const
