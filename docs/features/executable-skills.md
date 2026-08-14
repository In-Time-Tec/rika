# Executable skills

A discovered skill whose directory contains a `package.json` with a `rika` object of kind `skill` is executable. Its import name is that object's `importName`, or the package `name` when `importName` is absent; a manifest without either is listed as an ordinary skill and nothing more. The manifest must resolve inside its own skill directory, and a manifest that escapes it fails discovery.

A global executable skill is importable inside a cell. A Workspace executable skill is importable only when the Workspace is trusted; until then it is listed as untrusted and cannot be imported. Only importable skills contribute to the kernel bindings digest, so an untrusted skill never changes the kernel epoch.

Skills cost a listing, never a body. The prompt lists each skill's name and one capped description line, then names the importable executable skills with the module name to import, then names the untrusted ones. Listings are bounded to forty skills and two hundred characters a line.

Each pinned skill contributes its name and digest — never its body — to the Execution manifest as a capability under the `rika-skill` codec, so a changed skill yields a different Execution rather than silently altering a replay.
