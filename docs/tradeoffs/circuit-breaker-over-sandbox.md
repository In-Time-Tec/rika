# Circuit breaker over sandbox

**Gain:** local tools work on any path the user can reach, so sibling repositories, dotfiles, absolute paths, and miscased paths stop failing. A short hardcoded refusal list still stops the few mistakes nobody recovers from.

**Cost:** a confused or hostile model can read credentials and overwrite any user-writable file, and that content leaves the machine to the model provider. The refusal list is a mistake guard, not security: it recognises only high-confidence static command forms and is bypassable through variables, `eval`, an interpreter, or a generated script. Real isolation requires running Rika in a container.

**Rejected:** per-tool approval prompts add friction to every ordinary edit; workspace containment blocked real work without stopping `bash`; a long command deny-list produces false positives on legitimate `sudo`, `dd`, `mkfs`, and force-push work while giving false confidence; an OS sandbox is a host concern rather than a Rika one.
