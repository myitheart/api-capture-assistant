# API Capture Assistant repository family

This repository is the Companion member of a three-repository product family. A task started here may require coordinated inspection of these sibling Git repositories:

- `api-capture-assistant-extensions`: Chrome extension, product/developer capture UI, evidence collection, exports, Prompt construction, and native Harness draft sender.
- `api-capture-assistant`: native Harness launcher, portable release assembly, compatibility metadata, and cross-repository tests.
- `api-capture-harness`: DeepSeek Harness source fork, native Web Prompt draft bridge, platform runtime integration, and source-built Harness distribution.

If the project family is moved to another parent directory, resolve the same three repository names as siblings of the current repository instead of relying on these absolute paths.

Do not assume the current working directory is the complete implementation scope. For API Capture tasks, first identify the owning repository or repositories. Inspect sibling code when behavior crosses extension payloads, Companion APIs, business evidence tools, Harness sessions, build metadata, or release packaging. A request confined to one owner does not authorize unrelated changes in all three repositories.

Keep all repositories as independent Git histories. Check and report branch, status, diff, tests, commits, and remotes separately. Preserve dirty files. Never recreate a missing sibling, move code between repositories, commit, or push unless the user requests that action.

The primary interaction is Prompt-only: the extension sends one editable Prompt to the Harness Fork's loopback draft bridge, which fills the native composer without submitting it. Do not reintroduce a custom task center, mandatory read-only phase, approval flow, or Worktree console unless the user explicitly changes this architecture. Shared compatibility points are the draft HTTP API, `companion/harness.lock.json`, Harness `harness-build.json`, Bridge protocol version, and product/developer Prompt semantics.

Relevant validation commands:

- Launcher/release: `npm test`, `npm run build:portable`, and `npm run smoke:portable` when release/runtime behavior changes.
- Extension: run `node --check background.js`, `node --check popup.js`, and `node --test tests/*.test.js` from the extension repository.
- Harness: follow its own root and nested `AGENTS.md`; for the draft bridge use its focused Vitest suite and `pnpm run build:api-capture-web`.
