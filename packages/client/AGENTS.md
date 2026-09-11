# @rika/client

Owns the hosted TUI client boundary. The product adapter is limited to identity, access, catalog, and Thread-to-
Generalist Session admission. The Generalist adapter owns all execution reads and commands through the released
`generalist/server` client. This package never stores a second transcript or execution journal.

Keep selection, cursor, queue revision, receipt, and preview fencing in the client projection. A reconnect replaces
the committed Generalist snapshot before replaying live events; a stale selection or preview cannot mutate the
current Thread.
