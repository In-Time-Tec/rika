# E2B is the remote execution boundary

An explicitly remote Thread executes in E2B. A local Thread executes on its registered device. Execution kind is immutable and Rika never falls back or migrates between the two kinds automatically.

E2B supplies isolation, process and PTY lifecycle, pause and resume, and replaceable workspace state. PostgreSQL remains authoritative for the Thread, access, command order, assignment generation, cursors, and checkpoints; Baton remains authoritative for Runs. This lets a sandbox be paused, replaced, or fenced without changing Thread identity or accepting writes from two executors.

Supporting one remote provider keeps lifecycle, security, and recovery semantics exact. A generic multi-provider facade is rejected until a second provider is an actual product requirement.
