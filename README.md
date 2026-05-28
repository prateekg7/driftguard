# driftguard

AI coding agents are only as good as the project context you give them. When `CLAUDE.md` or `AGENTS.md` says auth lives in `src/middleware/auth.ts`, but the code was moved to Supabase three PRs ago, every new agent session starts from a confident lie.

`driftguard` watches committed code changes, finds context-file statements that may now be stale, asks an LLM for the smallest safe edit, and gives you a reviewable suggestion or pull request. It does not regenerate your context from scratch, and it never blocks your commits.

Live demo PR: https://github.com/prateekg7/throwaway-test/pull/1

## Quick Start

```sh
npm install -D driftguard
export GROQ_API_KEY=your_key_here
npx driftguard init
npx driftguard scan
```

Use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or local Ollama instead if you prefer another provider.

## How It Works

```text
git commit
  |
  v
git diff -> reference parser -> drift detector -> proposal writer / PR creator
```

1. `git diff` extracts changed, deleted, and renamed files.
2. The parser reads `CLAUDE.md` and `AGENTS.md`, extracting file paths, libraries, commands, and rules.
3. The detector flags only statements that reference changed code with enough confidence.
4. The proposal step writes `CLAUDE.md.suggested` / `AGENTS.md.suggested` or creates a PR with a surgical diff.

## Configuration

`driftguard.config.json` is optional. Defaults are:

| Option | Type | Default |
|---|---:|---|
| `$schema` | string | `https://driftguard.dev/schema/v1.json` |
| `contextFiles` | string[] | `["CLAUDE.md", "AGENTS.md"]` |
| `confidenceThreshold` | number | `0.65` |
| `ignorePaths` | string[] | `["node_modules/**", "dist/**", "*.lock", "*.snap", "*.generated.*"]` |
| `ignoreCommitPatterns` | string[] | `["^chore\\(driftguard\\):", "^Merge pull request"]` |
| `provider` | `"anthropic" \| "openai" \| "ollama" \| "groq"` | `"anthropic"` |
| `model` | string | provider default |
| `ollamaBaseUrl` | string | `http://localhost:11434` |
| `groqBaseUrl` | string | `https://api.groq.com/openai/v1` |
| `maxTokensPerProposal` | number | `2000` |
| `prMode.enabled` | boolean | `false` |
| `prMode.autoCreatePR` | boolean | `false` |
| `prMode.baseBranch` | string | `main` |
| `prMode.titleTemplate` | string | `chore(driftguard): update {filename} — {trigger}` |
| `prMode.labels` | string[] | `["context-drift", "automated"]` |
| `prMode.assignees` | string[] | `[]` |
| `prMode.reviewers` | string[] | `[]` |
| `output.mode` | `"local" \| "pr"` | `"local"` |
| `output.verbose` | boolean | `false` |
| `output.hookMode` | boolean | `false` |

Provider default models:

| Provider | Default model |
|---|---|
| `anthropic` | `claude-3-haiku-20240307` |
| `openai` | `gpt-4o-mini` |
| `groq` | `llama-3.1-8b-instant` |
| `ollama` | `llama3` |

Suppress one statement with:

```md
<!-- driftguard-ignore: this reference is intentionally abstract -->
- Auth patterns live in the services layer.
```

## GitHub Action

```yaml
name: driftguard

on:
  pull_request:

jobs:
  driftguard:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: your-org/driftguard/action@v1
        with:
          groq-api-key: ${{ secrets.GROQ_API_KEY }}
          github-token: ${{ github.token }}
          confidence-threshold: '0.65'
          comment-on-pr: 'true'
```

The action posts one regular PR comment. It updates its previous `<!-- driftguard-comment -->` comment on later commits instead of spamming duplicates.

## FAQ

**Will this block my commits?**

No. The installed hook runs `npx driftguard scan --hook-mode 2>/dev/null || true`, so commits continue even if driftguard, git, or the LLM provider is unavailable.

**How much does it cost?**

Usually one API call per flagged commit. With Haiku it is roughly around a cent for small diffs, Groq may fit free-tier testing, and Ollama is free locally.

**Can I use it without a GitHub token?**

Yes, in local mode. Without GitHub auth, driftguard writes `.suggested` files instead of creating PRs.

**Does it work with monorepos?**

Yes. driftguard detects `CLAUDE.md` and `AGENTS.md` independently and scopes proposals to each context file it finds.

## Comparison

| Tool | What it does | Gap |
|---|---|---|
| `context-drift` | Checks dead paths and missing scripts | Shallow linting, no semantic proposal |
| `claude-md-auto-updater` | Manual scan skill with suggested diffs | Not automatic on commits or PRs |
| `Ruler` | Distributes rules across AI tools | Sync only, no drift detection |
| `rulesync` | Generates config files for many tools | Sync only, no update proposal |
| `driftguard` | Detects code/context drift and proposes reviewable updates | Focused on keeping existing context fresh |
