# Local installation doctor

`rika doctor` reports whether global and Workspace settings are present, along with configuration diagnostics, the locally configured model route, and credential presence without printing secret values.

Doctor runs locally without authentication or a model request. It does not inspect hosted databases, verify the hosted model route, or check server connectivity. Invalid local configuration fails the command instead of producing a healthy report.
