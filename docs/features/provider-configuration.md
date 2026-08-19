# Provider connection configuration

Model routes and non-secret provider connection settings may be defined locally or by the hosted control plane. Credentials have one explicit scope: `local`, `user`, or `organization`. Local credentials stay in the operating-system credential store and are usable only by that device. Hosted credential read APIs return metadata, never secret material.

A hosted credential is envelope-encrypted with a fresh AWS KMS data key and AES-256-GCM. Its authenticated data binds credential identity, owner, provider, and revision. Railway stores only ciphertext and the wrapped data key; plaintext and plaintext data keys remain operation-scoped and redacted. Revocation prevents new decrypts and interrupts dependent model fibers but cannot claw back a request already sent to a provider.

A user credential may serve an Organization Thread only through an explicit Thread binding by its owner. That binding records consent for eligible controllers and is visible in audit history. An Organization owner or admin manages Organization credentials, and a Project operator may bind one to a Thread. Membership removal deletes that member's grants and bindings. Executors receive only short-lived assignment-scoped grants and never store hosted credentials in checkpoints, metadata, process arguments, or logs.

Provider account login is separate from Rika account login. Human identity uses `rika auth`; provider secrets use `rika credential`. GitHub sign-in is also separate from the repository GitHub App, whose installation tokens are minted on demand and scoped to one repository and the required permissions.
