# Local installation doctor

`rika doctor` reports whether the product and execution databases and global and Workspace settings are present, along with configuration diagnostics, the configured model route, and needed credential status. It reports credential presence without printing secret values.

Doctor is a server-backed operation but does not run a model. Invalid configuration or server startup failure fails the command instead of producing a healthy report.
