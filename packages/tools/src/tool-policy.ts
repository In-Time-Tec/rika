import { Schema } from "effect"

export const Permission = Schema.Literals(["allow", "ask"])
export type Permission = typeof Permission.Type

export const Idempotency = Schema.Literals(["safe", "unsafe"])
export type Idempotency = typeof Idempotency.Type

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Presentation = Schema.Struct({
  family: Schema.Literals(["explore", "shell", "edit", "agent", "direct", "generic"]),
  action: Schema.String,
  activeLabel: Schema.String,
  completeLabel: Schema.String,
  counter: Schema.optionalKey(
    Schema.Literals([
      "file",
      "media file",
      "web page",
      "thread",
      "skill",
      "guidance file",
      "search",
      "web search",
      "review",
      "GitHub check",
      "list",
    ]),
  ),
})
export type Presentation = typeof Presentation.Type

export const Policy = Schema.Struct({
  permission: Permission,
  idempotency: Idempotency,
  timeoutMillis: PositiveInt,
  outputLimit: PositiveInt,
  presentation: Presentation,
})
export type Policy = typeof Policy.Type

const allow = (
  idempotency: Idempotency,
  timeoutMillis: number,
  outputLimit: number,
  presentation: Presentation,
): Policy => ({ permission: "allow", idempotency, timeoutMillis, outputLimit, presentation })

export const policies = {
  find_files: allow("safe", 10_000, 20_000, {
    family: "explore",
    action: "search",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "search",
  }),
  grep: allow("safe", 10_000, 40_000, {
    family: "explore",
    action: "grep",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "search",
  }),
  read: allow("safe", 10_000, 40_000, {
    family: "explore",
    action: "read",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "file",
  }),
  write: allow("unsafe", 10_000, 4_000, {
    family: "edit",
    action: "create",
    activeLabel: "Creating",
    completeLabel: "Created",
  }),
  edit: allow("unsafe", 10_000, 4_000, {
    family: "edit",
    action: "edit",
    activeLabel: "Editing",
    completeLabel: "Edited",
  }),
  bash: allow("unsafe", 120_000, 40_000, {
    family: "shell",
    action: "command",
    activeLabel: "Running",
    completeLabel: "Ran",
  }),
  shell_command_status: allow("safe", 10_000, 40_000, {
    family: "direct",
    action: "status",
    activeLabel: "Waiting for",
    completeLabel: "Waited for",
  }),
  git_status: allow("safe", 10_000, 20_000, {
    family: "direct",
    action: "git-status",
    activeLabel: "Inspecting",
    completeLabel: "Inspected",
  }),
  web_search: allow("safe", 30_000, 40_000, {
    family: "direct",
    action: "web-search",
    activeLabel: "Web Search",
    completeLabel: "Web Search",
    counter: "web search",
  }),
  read_web_page: allow("safe", 30_000, 40_000, {
    family: "direct",
    action: "read-web-page",
    activeLabel: "Read",
    completeLabel: "Read",
    counter: "web page",
  }),
  view_media: allow("safe", 30_000, 40_000, {
    family: "explore",
    action: "media",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "media file",
  }),
  task: allow("unsafe", 120_000, 40_000, {
    family: "agent",
    action: "task",
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  }),
  oracle: allow("unsafe", 120_000, 40_000, {
    family: "agent",
    action: "oracle",
    activeLabel: "Oracle exploring",
    completeLabel: "Oracle has spoken",
  }),
  librarian: allow("unsafe", 120_000, 40_000, {
    family: "agent",
    action: "librarian",
    activeLabel: "Librarian researching",
    completeLabel: "Librarian researched",
  }),
  review: allow("unsafe", 120_000, 40_000, {
    family: "agent",
    action: "review",
    activeLabel: "Reviewing code",
    completeLabel: "Reviewed code",
    counter: "review",
  }),
  find_thread: allow("safe", 10_000, 20_000, {
    family: "explore",
    action: "find-thread",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "thread",
  }),
  read_thread: allow("safe", 10_000, 40_000, {
    family: "direct",
    action: "read-thread",
    activeLabel: "Reading Thread",
    completeLabel: "Read Thread",
  }),
} as const satisfies Readonly<Record<string, Policy>>

export const get = (name: string): Policy | undefined =>
  Object.hasOwn(policies, name) ? policies[name as keyof typeof policies] : undefined
