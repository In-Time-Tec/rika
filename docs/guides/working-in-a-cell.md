# Working in a cell

This walks one Thread from a first cell to a delegated child. It is procedure only: each capability's contract lives in its own feature document.

Start by looking at what you are working in. `context` is already bound when your first cell runs.

```ts
console.log(context.workspace, context.threadId, context.trustMode)
```

Find something, then read it. Both are inline calls with no approval.

```ts
const hits = await rika.workspace.search({ pattern: "makeCellProjection" })
const file = await rika.workspace.read({
  path: "packages/execution/src/projection/cell/state.ts",
  range: [1, 40],
})
console.log(hits.text, file.text)
```

Bind what you want to keep. Values, functions, and imports survive into the next cell of the same Thread, so the next cell can use `file` without reading again. They do not survive a kernel restart; a restart appears in the transcript as a notice listing what was restored and what was lost.

Change the file. A replace is a durable nested operation with an approval capability naming the path, and its diff appears on the cell row.

```ts
const edited = await rika.workspace.replace({
  path: "packages/execution/src/projection/cell/state.ts",
  oldStr: "export const maxCellNotices = 32",
  newStr: "export const maxCellNotices = 64",
})
console.log(edited.diff)
```

Run a command. A start returns a process id when the command outlives its initial wait; poll it for newly retained output.

```ts
const started = await rika.processes.start({ command: "bun --version", timeoutMillis: 5_000 })
console.log(started.text, started.exitCode)
```

A failing binding rejects with its tagged failure value, so catching gives you data to branch on rather than an anonymous error.

```ts
try {
  await rika.workspace.read({ path: "no/such/file.ts" })
} catch (failure) {
  console.log((failure as { _tag: string })._tag)
}
```

Delegate when the work is large or independent with the model-facing `run_child` and `run_child_group` tools, not from inside a cell. TenetKit suspends the current Run while it waits and resumes that same Run with the durable child result.

Keep what you learned. A harness refinement requires the baseline you read. The overview's first line is `harness <snapshotId> (scope <scope>)`, so read the scope you intend to write.

```ts
const overview = await rika.harness.overview({ scope: "thread" })
const baseSnapshot = overview.text.split("\n")[0].split(" ")[1]
await rika.harness.createMemory({
  id: "cell-projection-bounds",
  title: "cell notices are bounded",
  content: "maxCellNotices caps how many notices one cell keeps",
  baseSnapshot,
  scope: "thread",
})
```

A stale baseline is rejected as `baseline-drift`; read the scope again and retry.
