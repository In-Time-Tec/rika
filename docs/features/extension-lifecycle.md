# Extension lifecycle records

`rika extensions list` reports the stored enabled state and generation for named local extensions. `enable` and `disable` change that state, while `rollback` moves the stored generation toward the first generation and never below it.

These commands manage local extension records. Creating plugins or skills through `rika extensions` is rejected, and the lifecycle command does not itself load plugin code into an Execution.
