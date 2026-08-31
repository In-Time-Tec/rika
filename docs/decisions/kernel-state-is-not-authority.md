# Kernel state is not authority

The kernel namespace is working memory. Generalist operations, events, Session entries, and children remain the only durable truth, and Rika describes kernel variables that way to the model rather than implying they survive.

Namespace snapshots are therefore best-effort files under the Profile data root, keyed by Session and written owner-only through a same-directory temporary and rename. A missing snapshot is simply absent, a corrupt one is a typed non-fatal report, and neither fails the cell that triggered it. What restored and what was lost is reported into the transcript so the model can rebuild rather than assume.

The alternative — treating the namespace as recoverable state — would require replaying cell code whose external effects already committed, which is exactly the uncertainty the durable operation ledger exists to prevent.
