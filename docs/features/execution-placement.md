# Runner and Orb execution

Creating a Thread without an explicit target selects the current Runner. Selecting Orb creates an `orb` Thread backed by E2B. The target is durable and immutable; it is not encoded in Thread identity. Thread and executor-assignment IDs are independently generated opaque identifiers, and an assignment refers to its Thread explicitly. An unavailable Executor leaves the hosted Thread durable and visibly waiting instead of cancelling it or silently moving it.

The selected Executor owns Workspace access, kernels, coding tools, and processes. The API hosts TenetKit's PostgreSQL Runtime, model loop, and encrypted provider credential use, then dispatches Workspace operations through TenetKit's stable operation key. Hosted contracts carry opaque Workspace Identity rather than a host-local path. The Executor alone maps that identity to a path and accepts work only while holding the current assignment generation and lease epoch.

A Runner is a registered user-controlled process rooted in one approved checkout. Interactive Rika registers the current checkout; headless Rika can accept remotely created Threads. A Runner never becomes an Orb implicitly.

An Orb receives a fresh Project checkout, runs repository setup, pauses without memory after fifteen idle minutes, and cold-resumes when authorized work or a portal request arrives. Recovery uses committed TenetKit and API cursors, checkout identity, and verified Workspace checkpoint artifacts. Portals expose an authenticated E2B service hostname through the shared Thread protocol. E2B credentials never reach a CLI, TUI, or browser.

The shared Thread protocol also owns repository service start/stop and portal requests. `rika thread service`, `rika thread portal`, and the FoldKit client call that protocol; they do not contact E2B directly. `rika thread sync` submits one approved commit SHA to the API repository-publication workflow with a stable idempotency key. The API authorizes the Thread's Project and repository, then performs the bounded branch publication; a client never receives the installation credential.
