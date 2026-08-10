# Rika improvement plan

Written after stopping a wedged agent session and reading what it left behind. Every number here was
measured on 0.5.1, not estimated.

## What happened

A session was asked to research Rika with subagents. It spawned four, each of which ran for fifteen
minutes or more. The parent could not wait for them, so it polled. While it polled, the server
pushed 37,888 feed messages on a single request over 43 minutes, reached 100% CPU and 6.3 GB
resident, and the turn failed. Killing the server was not enough — the client restarted it within
seconds — so the interactive process had to be stopped first.

None of this is one bug. It is three limits meeting each other.

## The three that produced the wedge

### A cell is killed at two minutes and nothing says so

`cellDeadlineMillis` is 120,000 and appears in no description, no error text, and no part of the
surface a model reads. The agent discovered it by being killed mid-cell and wrote "the host aborts
long cells (~80-90s)" — it guessed, and it guessed wrong, because all it could see was wall-clock
time before the process went away.

Fix: name the limit in the cell surface, and when a cell is killed for exceeding it, say so with the
number. A model that knows it has two minutes writes different code than one that has learned to
fear ninety seconds.

### A parent cannot wait for a child that takes longer than thirty seconds

`agents-binding.ts` caps `waitMillis` at 30,000. A subagent doing real work runs for minutes, so the
parent has no way to await it and falls back to polling. The wedged run executed 126 cells, most of
them polls that returned "running".

Fix: let a parent wait as long as the cell deadline allows, and give `inspect` something to report
while a child is still working. A poll that returns only "running" teaches a model nothing except to
poll again.

### The feed re-serialises a growing checkpoint on every event

Measured on a cell that computes `1`: 37 projection patches, 71 KB total, mean 1,921 bytes a patch,
and 68% of each patch is a re-serialized checkpoint cursor and state blob. The checkpoint grows with
the transcript, so the cost is superlinear in turn length, and four concurrent subagent runs
multiply it. That is the CPU pin and the 6.3 GB.

Fix: send the checkpoint when it changes, not with every patch. This is the single highest-value
performance change available and it is measurable before and after with the numbers above.

## Programmatic access to session history

This is what the session was asked to look at, and it is genuinely poor.

`threads.read` returns `{ text }` where `text` is a JSON string whose shape a model has to guess. The
turns are under `items`, not `turns`, and nothing says so. `context.historyPage` returns zero entries
during the turn producing them, because session entries are written when a turn ends.

Prime-agent's format is the right model to follow, and its principles are visible in its own files:
one append-only JSONL per session, every record typed and self-describing, `parentId` linking records
into a tree, and usage and status recorded as events rather than derived. A 25,243-record session is
still readable with `tail` and `jq`.

Rika should adopt the same three properties:

1. Return structured values, not JSON strings. `threads.read` should return typed turns directly.
2. Make a session readable as an append-only record stream, so a cell can page it, a developer can
   tail it, and two runs can be diffed without the app.
3. Record why a turn failed. `rika_turns` keeps `status = failed` and nothing else; root-causing this
   incident meant reading a 342 KB transcript blob out of the Baton journal.

## Papercuts worth fixing

- A killed server respawns immediately because the client restarts it. Stopping Rika should be one
  documented action, not a race between two processes.
- The server outlives its client indefinitely at ~3% CPU with nothing connected.
- Turn failures surface as `OperationError` with no cause on the client.
- `rika.goal.start` does not exist; the operation is `create`. A model that guesses `start` gets a
  runtime error rather than a hint.

## Order

Do the feed checkpoint first: it is measured, it is contained, and it is what made the machine
unusable. Then the two limits, because together they are what made a reasonable request impossible to
carry out. Then history access, which is the thing that was actually asked for and the largest piece
of work.

## What not to do

Do not raise the cell deadline without telling the model about it. The limit is not the problem; a
limit nobody can see is.
