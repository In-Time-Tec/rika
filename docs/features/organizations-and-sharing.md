# Organizations and sharing

Every hosted Project and Thread belongs to one Hosted Owner. Every user has a Personal Owner; Organization Owners and membership are optional. Projects are optional, so a Thread may belong directly to either owner kind. Organization roles govern membership administration. Rika grants govern product resources: `viewer` reads transcript, status, presence, and terminal output; `controller` also submits, steers, cancels, and answers approvals; `operator` also controls terminal input and executor lifecycle; `owner` also changes sharing and destructive metadata.

A local Thread starts creator-only because its Executor acts with that device user's filesystem authority. A remote Thread may inherit its Project grants. Sharing never reveals provider, GitHub App, E2B, or executor bootstrap credentials.

Authorized collaborators receive the same durable command and event order. Commands are idempotent, actor-attributed, and sequenced per Thread. Terminal output is broadcast, while terminal input belongs to one renewable controller lease so simultaneous clients cannot interleave bytes.
