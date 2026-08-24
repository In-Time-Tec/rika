export const defaultCompactionSummaryPrompt = `Summarize the conversation so another agent can continue seamlessly.

Use Markdown with these sections:

## Goal
## Constraints
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Do not mention that context was compacted.`
