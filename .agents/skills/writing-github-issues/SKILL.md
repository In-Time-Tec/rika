---
name: writing-github-issues
description: Creates and rewrites concise GitHub design issues with a concrete API example and current/desired runtime diagrams. Use before creating, splitting, or editing implementation issues in this repository.
---

# Write a small design proposal

Help the reader understand the requested behavior before telling them how to implement it. An issue should answer: what cannot be done today, what should the caller write or the user do, and how should the system behave afterward?

Use Dallen Pyrah's Alchemy issues as the style references:

- [Local Docker context deployment, #1435](https://github.com/alchemy-run/alchemy/issues/1435): Summary → Current flow → Proposed API → Desired runtime → Why.
- [Private Service, #1436](https://github.com/alchemy-run/alchemy/issues/1436): Summary → Current runtime → Proposed API → Desired runtime. No redundant Why section.
- [Pre-deploy commands, #1437](https://github.com/alchemy-run/alchemy/issues/1437): Summary → Proposed API → Desired runtime → Why. No unnecessary Current section.

These are examples of proportion and reasoning, not a form that requires every heading.

## Research before writing

Read the affected implementation, current public API, and relevant release or feature documentation. Distinguish a verified behavior from a suspected cause. Describe existing primitives accurately instead of proposing to rebuild capabilities that already ship.

Read the existing issue before editing it. Preserve its problem, important failure semantics, reproduction evidence, dependency links, and explicit exclusions. Change its explanation, not its scope. When shortening a larger plan, retain the one constraint whose omission would lead someone to build the wrong thing.

For a split, give each issue one independently understandable outcome. Link genuine prerequisites; do not paste the whole architecture, safety policy, and acceptance program into every child.

## Title

Prefer `feat(scope): concrete capability`, `fix(scope): observable correction`, or the matching `perf`, `refactor`, `test`, or `chore` type. Name the consumer-visible change, not a planning phase or tracking key.

## Body

### Summary

Start with one sentence stating the change. Add one or two sentences explaining the current limitation and its consequence. Avoid introductory boilerplate, praise, or an implementation checklist.

### Current flow or Current runtime

Include this only when a short before-picture explains the problem better than prose. Use a fenced `text` diagram with real components and the failure point. Do not assert an unverified root cause; label a reported symptom or a hypothesis honestly.

### Proposed API

When the public interface changes, show the smallest concrete example that makes the proposal understandable. Follow the repository's language and vocabulary; preserve typed input/output and ownership boundaries. Prefer a realistic consumer call over a type declaration full of placeholders.

The heading marks a proposed interface, not a released API. Label fragments that assume a surrounding Effect generator or injected services. Do not imply a snippet is runnable or verified unless it was tested. For a rendering fix, storage implementation, deletion, or test-only task, omit this section when no new public API is needed. Do not invent one to satisfy the layout.

### Desired runtime

Show the sequence from input to observable outcome in a small fenced `text` diagram. Use arrows, branches, and tree lines to explain order and alternatives. Name who records, executes, waits, and returns.

For durable work, distinguish canonical commits from process memory, provisional previews, and external side effects. Include the relevant crash, conflict, or unknown-outcome branch. An arrow is not proof of atomicity or exactly-once external execution.

Follow with a short paragraph only when a boundary cannot be expressed clearly in the diagram. Put the decisive success or regression condition here, rather than adding a long Done when checklist.

### Why

Include a brief explanation when the benefit or tradeoff is not already obvious. Connect the mechanism to what the user can do or what failure disappears. Do not repeat the Summary.

### Links

End with a short `Depends on ...` or `Related: ...` line when needed. Preserve original issue numbers and cross-repository dependencies. Link detailed background instead of copying the same execution notes into every issue.

## Keep it proportionate

Aim for roughly 100–250 words plus compact examples/diagrams; let the actual change determine the length. Do not replace clarity with compressed jargon just to hit a word count.

Avoid default Goal/Scope/Done when/Execution notes scaffolding, exhaustive file lists, repeated release warnings, generic testing checklists, implementation micromanagement, and giant umbrella descriptions. Keep an essential safety condition or measurable regression even if that needs another sentence.

## Review and publish

Before publication, check that the title, API example, diagram, and prose describe the same change; current and proposed behavior are distinguishable; dependencies still resolve; and every concrete claim has evidence. Check Markdown fences, diagram readability, and code syntax. When editing, preserve issue state and do not silently replace another person's concurrent edits.

Read the published title/body back from GitHub and verify they match the intended content. Editing an issue does not authorize implementing it, merging code, publishing packages, or changing production.
