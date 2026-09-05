import { Schema } from "effect"
import { ThreadViewSnapshot } from "@rika/product/thread-view"
import { emptyUsageState, projectionVersion } from "@rika/product/execution-projection"

export const reviewSnapshot = Schema.decodeUnknownSync(ThreadViewSnapshot)({
  thread: {
    id: "browser-review-sample",
    workspace: "review-fixture",
    title: "Review: safer Thread navigation",
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt: 2,
  },
  revision: 1,
  source: { projectionVersion },
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: emptyUsageState() },
  turns: [
    {
      turn: {
        id: "review-turn",
        threadId: "browser-review-sample",
        kind: "agent",
        prompt: "Review the navigation changes.",
        status: "completed",
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        createdAt: 1,
        updatedAt: 2,
      },
      projectionRevision: 1,
      usage: emptyUsageState(),
      units: [
        { _tag: "Entry", role: "user", text: "Review the **Thread navigation** changes and show the patch." },
        {
          _tag: "Entry",
          role: "assistant",
          text: "## Changes ready for review\n\nThe browser keeps the selected Thread while a new connection loads.\n\n- Existing conversation remains readable.\n- Unauthorized Threads are excluded.\n- [Protocol notes][notes] stay linked after streaming completes.\n\n[notes]: https://example.com/protocol\n\n| Check | Result |\n| --- | --- |\n| Typecheck | Passed |\n| Reconnect | Snapshot restored |",
        },
        {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            id: "tool",
            name: "edit",
            detail: "Update navigation.ts",
            input: '{"path":"src/navigation.ts"}',
            status: "complete",
            presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
            result: "Updated 1 file",
            process: { stdout: "2 tests passed\n", exitCode: 0, running: false },
            files: [
              {
                key: "file",
                path: "src/navigation.ts",
                kind: "update",
                additions: 2,
                deletions: 1,
                preview: false,
                status: "complete",
                patch: "@@ -12,1 +12,2 @@\n-clearTranscript()\n+await attachThread(nextId)\n+commitSelection(nextId)",
              },
            ],
          },
        },
        {
          _tag: "Block",
          block: { _tag: "ToolResult", id: "result", output: "Checks completed successfully.", failed: false },
        },
        {
          _tag: "Entry",
          role: "assistant",
          text:
            "### Long output\n\n" +
            "This is a deliberately long review paragraph to check wrapping without hiding useful content. ".repeat(
              15,
            ) +
            "\n\n```text\n" +
            "long-unbroken-output-".repeat(35) +
            "\n```\n\n<script>alert('untrusted')</script>\n\n[Unsafe link](javascript:alert%281%29) ![Remote image](https://tracking.invalid/pixel)",
        },
      ].map((content, index) => ({
        key: `review-unit-${index}`,
        turnId: "review-turn",
        order: [{ sequence: index, part: 0, key: `review-unit-${index}` }],
        revision: 1,
        content,
      })),
    },
  ],
})
