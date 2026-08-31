# Changelog

## [0.0.2](https://github.com/Speechify-AI/cli/compare/0.0.1...0.0.2) (2026-08-31)


### Features

* add api passthrough + MCP server (ported from draft CLI) ([0be6386](https://github.com/Speechify-AI/cli/commit/0be6386a4460f2286256fe3a6f5051ae41d2d8bf))
* **auth:** API-key-only authentication ([#11](https://github.com/Speechify-AI/cli/issues/11)) ([719b209](https://github.com/Speechify-AI/cli/commit/719b209b381097c2e4bddb9feba8662efffced22))
* **auth:** PKCE browser login flow (no token in the URL) ([bbce7ea](https://github.com/Speechify-AI/cli/commit/bbce7eac03b94d6dc228d35d7cb96eb559efb181))
* **cli:** add `keys` and `usage` commands over console internal API ([e72266f](https://github.com/Speechify-AI/cli/commit/e72266f2fde606489016d025eaa337b17e576e41))
* **cli:** agent-first output, OS-keychain storage, api-key login ([8a7d060](https://github.com/Speechify-AI/cli/commit/8a7d060c9c4df885068def3e7c0d29268c9e3260))
* **cli:** fetch one voice with `voices get` ([#7](https://github.com/Speechify-AI/cli/issues/7)) ([7d607e5](https://github.com/Speechify-AI/cli/commit/7d607e583a2a073d9932ed058042254f0aa53953))
* **cli:** stream long-form speech with say --stream ([#6](https://github.com/Speechify-AI/cli/issues/6)) ([ad1f436](https://github.com/Speechify-AI/cli/commit/ad1f4363c1bd18c7684fd983846a8c1b8372911c))
* **cli:** voices list filters + whoami identity and --check ([bac764d](https://github.com/Speechify-AI/cli/commit/bac764d17ac5dc45870755377888b2186206545a))
* console-user auth + workspace context (foundation) ([#1](https://github.com/Speechify-AI/cli/issues/1)) ([807f76e](https://github.com/Speechify-AI/cli/commit/807f76e45d22af34fc3e123a61ea6601746b384d))
* Speechify CLI v1 — auth, say, voices ([bdc63c4](https://github.com/Speechify-AI/cli/commit/bdc63c4afefe96a45d0ee76d59b4022fef1aa452))


### Bug Fixes

* **auth:** cache ID token across invocations to avoid refresh-token churn ([9e2ae43](https://github.com/Speechify-AI/cli/commit/9e2ae43207c5a07b5ea3c66151bcb7859b8e8eea))
* **cli:** fail-fast filters, source-aware requires_console, doc fixes ([fa4a7dd](https://github.com/Speechify-AI/cli/commit/fa4a7dd106d08ef5f5db099c04c560f4fe51621a))
* **cli:** harden auth, output, and networking from CLI review ([a7732c1](https://github.com/Speechify-AI/cli/commit/a7732c16141658463e7273d057309b7f45c17d50))
* **cli:** harden MCP transport, file writes, auth & input from review ([#12](https://github.com/Speechify-AI/cli/issues/12)) ([1cf46bf](https://github.com/Speechify-AI/cli/commit/1cf46bf0f2541f3ccaac62929315c204d6befcac))
* **cli:** use canonical bin path (drop ./ so npm keeps the bin on publish) ([#15](https://github.com/Speechify-AI/cli/issues/15)) ([8146364](https://github.com/Speechify-AI/cli/commit/8146364a5dc13699e5fa3384a117fefbf510f783))
* **mcp:** always register TTS tools, resolve auth per call ([d64b7be](https://github.com/Speechify-AI/cli/commit/d64b7be88b3b034b77d8400df7610035f63629ce))
