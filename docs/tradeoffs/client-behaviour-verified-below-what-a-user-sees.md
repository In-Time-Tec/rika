# Client behaviour verified below what a user sees

**Gain:** controller and in-process TUI tests cover most terminal behavior quickly. They drive real state reduction and rendering for native tool and subagent rows without starting a hosted server or PTY.

**Cost:** these levels do not prove that the packaged client assembles the same path a user sees. A function can return the right activity while its caller omits it. Process tests therefore retain representative assertions for an active native tool, background status polling, cancellation, and terminal settlement.

**Rejected:** moving all client behavior to process tests would make the slowest and least deterministic lane the primary feedback loop. Focused process tests cover integration seams; controller and TUI tests keep ordinary rendering failures fast and precise.
