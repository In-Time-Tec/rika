export const delegationCapabilityGuidance =
  "Before spawning a child, validate every path requirement in its prompt against the selected profile. " +
  "Librarian is web-only and cannot read workspace paths, relative or absolute local paths, or file:// URLs. " +
  "Refuse a mismatched Librarian spawn with an actionable warning, and select Task or Oracle for local-file work."

export const librarianCapabilityGuidance =
  "Your tools are web-only. If the request requires a workspace path, relative or absolute local path, or file:// URL, " +
  "refuse and tell the parent to use a local-capable Task or Oracle child."
