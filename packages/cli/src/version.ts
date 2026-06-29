import { Effect } from "effect"
import * as Args from "./args"
import * as Output from "./output"

const version = "0.0.1782665646-g2f0017"
const releasedAt = "2026-06-28T16:54:06.000Z"
const releasedAtMs = Date.parse(releasedAt)

export const versionText = (now = new Date()) => `${version} (released ${releasedAt}, ${ageText(now)} ago)`

const ageText = (now: Date) => {
  const elapsedMs = Math.max(0, now.getTime() - releasedAtMs)
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (elapsedMs < hourMs) return `${Math.floor(elapsedMs / minuteMs)}m`
  if (elapsedMs < dayMs) return `${Math.floor(elapsedMs / hourMs)}h`
  return `${Math.floor(elapsedMs / dayMs)}d`
}

export const executeCommand = Effect.fn("Cli.Version.executeCommand")(function* (command: Args.VersionCommand) {
  if (command.type === "version") {
    yield* Output.stdout(versionText())
  }
  return 0
})
