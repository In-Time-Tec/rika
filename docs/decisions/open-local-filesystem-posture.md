# Open local filesystem posture

The Workspace is a scope, not a security boundary. It anchors relative paths, the search index, settings, trusted guidance, and Thread identity, but local tools run with the authority of the user who started Rika and may read and write anywhere that user can. Containment was removed because it blocked ordinary work — a sibling repository, a dotfile, or a pasted absolute path — while never being a real boundary, since `bash` could reach past it.

Path casing is corrected when exactly one on-disk spelling matches, because a rejected path that plainly exists is a defect rather than a protection.

What remains is a hardcoded circuit breaker for a few catastrophic actions and the Workspace as the trust scope for automatically loaded configuration, extensions, and guidance. Arbitrary filesystem access does not imply trusting arbitrary local instructions.
