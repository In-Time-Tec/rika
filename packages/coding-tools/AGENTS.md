# @rika/coding-tools

Owns typed coding-tool contracts, execution metadata, bounded output, and Effect adapters, including web-research providers. Web-research SDKs are allowed only when they preserve Effect interruption, retry, and resource semantics; use Effect HTTP otherwise. Language-model provider SDKs, OpenTUI, SQL, and Generalist are forbidden. Every behavior-bearing adapter has a test layer.
