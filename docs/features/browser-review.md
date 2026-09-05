# Browser Thread review

The authenticated `/threads` page lists durable personal or organization Threads, filters active and archived work, and opens live read-only reviews. Listing and attachment both require owner access and `thread:view` permission; organization membership alone does not grant access to every Thread.

The browser renders the existing socket `ThreadViewAccumulator` through FoldKit: user and assistant Markdown, tool inputs/results/process output, and expandable file patches. Model and workspace HTML is rendered as text, links allow only HTTP(S), mailto and relative URLs, and images are not fetched. Long code and patches scroll within their blocks. Earlier content outside the retained snapshot window is identified, not silently presented as a complete history.

## Passive session capability

`/api/v1/threads/browser-socket` accepts the existing Thread protocol with an authenticated cookie session and an exact configured trusted Origin. It does not issue a device ticket or construct device attribution. Each connection is bound to its first successfully attached Thread, even after Detach; navigation creates a new connection and commits its snapshot only after validation succeeds.

The API validates the uncached, non-refreshing Better Auth session and current Thread access before delivery, and checks idle connections every second. Logout, expiry, membership loss and Thread grant removal close the connection. Session credentials stay in a server-only validation closure and never enter frames or persistence payloads.

Only attachment and detachment are accepted. Browser readers cannot acknowledge cursors, write presence, register a Runner, admit work, submit prompts, cancel, approve, publish, or control workspace services. Viewing does not wake a Runner. Device-bound CLI rules are unchanged. There is no browser approval backend or collaborative editing/presence parity.

Readers reuse durable replay and checkpoint/reset logic without storing cursor acknowledgements, so they cannot hold back device-driven compaction. Existing replay limits (10,000 attachment events and 32 MiB attachment/output bounds) apply; a slow reader is disconnected and can reconnect from a retained checkpoint. Reconnect and explicit retry are supported; mutation controls remain in the CLI.

Regression coverage includes cookie HTTP reads, exact-Origin socket admission, real Better Auth/PostgreSQL logout and expiry during live delivery, membership loss, denied mutations/acknowledgements, compaction resets, stale/foreign-frame rejection, and hostile Markdown rendering.
