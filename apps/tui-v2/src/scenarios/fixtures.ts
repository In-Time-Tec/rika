import type { Activity, ClientState, PendingTurn, ScenarioId, ThreadView, TranscriptItem } from "../client/model"

export const OFFLINE_NOTICE = "Offline demo: scripted events only; no network, auth, workspace, or model calls."

export const workspaceFiles: readonly string[] = [
  "README.md",
  "docs/design notes.md",
  "src/app.tsx",
  "src/client/model.ts",
]

export const clipboardImage = {
  bytes: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=",
    "base64",
  ),
  metadata: { kind: "binary" as const, mimeType: "image/png" },
}

export interface ScenarioThreadFixture {
  readonly id: string
  readonly title: string
  readonly target: ThreadView["target"]
  readonly activity: Activity
  readonly items: readonly TranscriptItem[]
  readonly pending: readonly PendingTurn[]
  readonly approval: ThreadView["approval"]
}

export interface ScenarioFixture {
  readonly id: ScenarioId
  readonly notice: string
  readonly connection: ClientState["connection"]
  readonly threads: readonly ScenarioThreadFixture[]
}

const noticeItem = (id: string): TranscriptItem => ({
  id,
  kind: "notice",
  title: "Offline demo",
  text: OFFLINE_NOTICE,
})

const idle = (id: string, kind: TranscriptItem["kind"], title: string, text: string): TranscriptItem => ({
  id,
  kind,
  title,
  text,
  status: "idle",
})

const stream = (
  id: string,
  kind: TranscriptItem["kind"],
  title: string,
  text: string,
  status: Activity,
): TranscriptItem => ({ id, kind, title, text, status })

const welcome: ScenarioFixture = {
  id: "welcome",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "welcome-runner",
      title: "Welcome to Rika",
      target: "runner",
      activity: "idle",
      items: [],
      pending: [],
      approval: null,
    },
  ],
}

const conversation: ScenarioFixture = {
  id: "conversation",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "conversation-runner",
      title: "Refactor the release command",
      target: "runner",
      activity: "idle",
      items: [
        noticeItem("conversation-offline"),
        {
          id: "conversation-user-1",
          kind: "user",
          title: "You",
          text: "Can you make the release command print a concise plan before it changes anything?",
        },
        idle("conversation-image", "image", "screen.png", "image/png · 800×600 · 2.4 KB"),
        idle(
          "conversation-reasoning-1",
          "reasoning",
          "Reasoning",
          "The command should expose intent before effects, keep the plan stable for scripts, and avoid reading a remote workspace in this offline preview.",
        ),
        idle(
          "conversation-tool-1",
          "tool",
          "Inspect command wiring",
          "simulated read: src/command/root/rika.ts\nsimulated read: src/release/package-manager.ts",
        ),
        {
          id: "conversation-assistant-1",
          kind: "assistant",
          title: "Rika",
          text: '## Plan-first release output\n\nThe release command can show a dry plan before invoking a package manager:\n\n- resolve the selected channel\n- list files that would change\n- ask for confirmation when the plan is non-empty\n\n```ts\nexport const renderReleasePlan = (plan: ReleasePlan): string =>\n  [\n    `channel: ${plan.channel}`,\n    `files: ${plan.files.length}`,\n    plan.files.map((file) => `  - ${file}`).join("\\n"),\n  ].filter(Boolean).join("\\n")\n```\n\nThat keeps the first screen useful to a human and predictable for automation.',
          language: "typescript",
        },
        {
          id: "conversation-diff-1",
          kind: "diff",
          title: "src/command/root/rika.ts",
          text: "diff --git a/src/command/root/rika.ts b/src/command/root/rika.ts\nindex 6d9a3a1..f1a6a2d 100644\n--- a/src/command/root/rika.ts\n+++ b/src/command/root/rika.ts\n@@ -42,1 +42,5 @@ export const run = (argv: readonly string[]) =>\n-  return executeRelease(config)\n+  const plan = makeReleasePlan(config)\n+  printReleasePlan(plan)\n+  return confirmRelease(plan).pipe(\n+    Effect.flatMap(() => executeRelease(config)),\n+  )\n",
          language: "diff",
        },
        {
          id: "conversation-assistant-2",
          kind: "assistant",
          title: "Outcome",
          text: "The preview is ready for review. In this fixture the patch is only displayed; no file or process is touched.",
        },
      ],
      pending: [],
      approval: null,
    },
  ],
}

const streaming: ScenarioFixture = {
  id: "streaming",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "streaming-runner",
      title: "Streaming answer",
      target: "runner",
      activity: "working",
      items: [
        noticeItem("streaming-offline"),
        {
          id: "streaming-user-1",
          kind: "user",
          title: "You",
          text: "Explain how the demo keeps a long answer readable while it streams.",
        },
        stream(
          "streaming-assistant-1",
          "assistant",
          "Rika",
          "The transcript keeps one assistant item and grows its text in place.\n\n",
          "working",
        ),
      ],
      pending: [],
      approval: null,
    },
  ],
}

const approval: ScenarioFixture = {
  id: "approval",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "approval-runner",
      title: "Authorization request",
      target: "runner",
      activity: "waiting",
      items: [
        noticeItem("approval-offline"),
        {
          id: "approval-user-1",
          kind: "user",
          title: "You",
          text: "Please prepare the release notes and stage the generated file.",
        },
        {
          id: "approval-tool-1",
          kind: "tool",
          title: "Authorization required",
          text: "The scripted runner asks to stage release-notes.md.\n\nNo real command is available in this offline fixture.",
          status: "waiting",
        },
      ],
      pending: [],
      approval: {
        id: "approval-1",
        title: "Allow staging release-notes.md?",
        detail: "Accept continues the scripted run; deny records a safe cancellation. Nothing touches the workspace.",
      },
    },
  ],
}

const children: ScenarioFixture = {
  id: "children",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "children-runner",
      title: "Parallel child runs",
      target: "runner",
      activity: "working",
      items: [
        noticeItem("children-offline"),
        {
          id: "children-user-1",
          kind: "user",
          title: "You",
          text: "Check the API, web app, and CLI surfaces in parallel, then summarize the result.",
        },
        stream(
          "children-reasoning-1",
          "reasoning",
          "Coordinator",
          "Three independent checks were scheduled. Their output is simulated and local to this thread.",
          "working",
        ),
        stream("children-child-api", "child", "api", "queued: inspect route contracts", "working"),
        stream("children-child-web", "child", "web", "queued: inspect client rendering", "working"),
        stream("children-child-cli", "child", "cli", "queued: inspect terminal commands", "working"),
        stream("children-assistant-1", "assistant", "Rika", "", "working"),
      ],
      pending: [],
      approval: null,
    },
  ],
}

const queue: ScenarioFixture = {
  id: "queue",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "queue-runner",
      title: "Pending instructions",
      target: "runner",
      activity: "working",
      items: [
        noticeItem("queue-offline"),
        {
          id: "queue-user-1",
          kind: "user",
          title: "You",
          text: "Review the migration plan and call out risky changes.",
        },
        stream(
          "queue-assistant-1",
          "assistant",
          "Rika",
          "I am reviewing the migration plan now. The next queued instructions will run in order when this turn settles.",
          "working",
        ),
      ],
      pending: [
        { id: "queue-pending-1", prompt: "Also check whether the rollback path is documented." },
        { id: "queue-pending-2", prompt: "Keep the final summary under five bullets." },
      ],
      approval: null,
    },
  ],
}

const error: ScenarioFixture = {
  id: "error",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "error-runner",
      title: "Execution failure",
      target: "runner",
      activity: "failed",
      items: [
        noticeItem("error-offline"),
        {
          id: "error-user-1",
          kind: "user",
          title: "You",
          text: "Run the generated check and show me why it failed.",
        },
        idle(
          "error-reasoning-1",
          "reasoning",
          "Reasoning",
          "The fixture intentionally returns a failure after validation so the recovery controls remain visible.",
        ),
        {
          id: "error-tool-1",
          kind: "tool",
          title: "Simulated check",
          text: "$ rika check --generated\n\nfixture exit code: 1",
          status: "failed",
        },
        {
          id: "error-error-1",
          kind: "error",
          title: "Execution failed",
          text: "The generated check reported an incompatible lockfile. Retry is safe in this demo because no process was started.",
          status: "failed",
        },
      ],
      pending: [],
      approval: null,
    },
  ],
}

const reconnect: ScenarioFixture = {
  id: "reconnect",
  notice: OFFLINE_NOTICE,
  connection: "reconnecting",
  threads: [
    {
      id: "reconnect-runner",
      title: "Connection interrupted",
      target: "runner",
      activity: "waiting",
      items: [
        noticeItem("reconnect-offline"),
        {
          id: "reconnect-user-1",
          kind: "user",
          title: "You",
          text: "Continue the interrupted review when the runner is available again.",
        },
        {
          id: "reconnect-assistant-1",
          kind: "assistant",
          title: "Rika",
          text: "The scripted connection is interrupted. Waiting for a deterministic reconnect event...",
          status: "waiting",
        },
      ],
      pending: [],
      approval: null,
    },
  ],
}

const largeDiff = `diff --git a/src/release/plan.ts b/src/release/plan.ts
index 1c03a12..8a72f54 100644
--- a/src/release/plan.ts
+++ b/src/release/plan.ts
@@ -1,9 +1,30 @@
+import { Effect } from "effect"
+
 export interface ReleasePlan {
   readonly channel: string
   readonly files: readonly string[]
+  readonly warnings: readonly string[]
 }
 
-export const makeReleasePlan = (files: readonly string[]): ReleasePlan => ({
-  channel: "stable",
-  files,
-})
+export const makeReleasePlan = (files: readonly string[]): ReleasePlan => {
+  const warnings = files
+    .filter((file) => file.endsWith(".lock"))
+    .map((file) => \`lockfile requires review: \${file}\`)
+
+  return {
+    channel: "stable",
+    files,
+    warnings,
+  }
+}
+
+export const renderReleasePlan = (plan: ReleasePlan): string =>
+  [
+    \`channel: \${plan.channel}\`,
+    \`files: \${plan.files.length}\`,
+    plan.warnings.length > 0 ? \`warnings: \${plan.warnings.length}\` : "warnings: none",
+    ...plan.files.map((file) => \`  - \${file}\`),
+  ].join("\\n")
+
+export const previewRelease = (files: readonly string[]) =>
+  Effect.succeed(renderReleasePlan(makeReleasePlan(files)))
`

const longHistoryItems = (): TranscriptItem[] => {
  const items: TranscriptItem[] = [noticeItem("long-offline")]
  for (let index = 1; index <= 250; index += 1) {
    const padded = String(index).padStart(2, "0")
    items.push({
      id: `long-user-${padded}`,
      kind: "user",
      title: "You",
      text: `Checkpoint ${index}: compare the release plan with the previous review and retain useful context.`,
    })
    items.push({
      id: `long-assistant-${padded}`,
      kind: "assistant",
      title: "Rika",
      text: `Checkpoint ${index} is recorded. The offline transcript keeps this item stable while later turns are appended.`,
    })
  }
  items.push({
    id: "long-reasoning-final",
    kind: "reasoning",
    title: "Reasoning",
    text: "The long fixture intentionally keeps enough history to exercise scrolling, disclosure, and stable item identity.",
    status: "idle",
  })
  items.push({
    id: "long-diff",
    kind: "diff",
    title: "src/release/plan.ts",
    text: largeDiff,
    language: "diff",
  })
  items.push({
    id: "long-assistant-final",
    kind: "assistant",
    title: "Outcome",
    text: "The complete review is available above. Scroll through the history to inspect each checkpoint and the large patch.",
  })
  return items
}

const long: ScenarioFixture = {
  id: "long",
  notice: OFFLINE_NOTICE,
  connection: "offline",
  threads: [
    {
      id: "long-runner",
      title: "Long transcript and diff",
      target: "runner",
      activity: "idle",
      items: longHistoryItems(),
      pending: [],
      approval: null,
    },
  ],
}

export const scenarioFixtures = {
  welcome,
  conversation,
  streaming,
  approval,
  children,
  queue,
  error,
  reconnect,
  long,
} satisfies Readonly<Record<ScenarioId, ScenarioFixture>>

export const getScenarioFixture = (id: ScenarioId): ScenarioFixture => scenarioFixtures[id]
