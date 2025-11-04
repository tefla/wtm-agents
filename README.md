# WTM Multi-Agent Workflow (Bun Edition)

This package adapts the OpenAI Cookbook example
["Building Consistent Workflows with Codex CLI & Agents SDK"] to the
Worktree Manager (WTM) ecosystem, now powered by the Bun runtime and the
`@openai/agents` TypeScript SDK.

A Project Manager agent coordinates a roster of Developer agents, provisions
dedicated git worktrees via `wtm`, and collaborates through the Codex MCP server.

## Requirements

- Bun 1.0+ (ships with a TypeScript runtime).
- `wtm` installed and on the path (or provide `--wtm /path/to/wtm`).
- Node.js-compatible environment variables for the OpenAI SDK (`OPENAI_API_KEY`).

Configure credentials locally (Bun auto-loads `.env` files within the project root):

```bash
cp .env.example .env
echo "OPENAI_API_KEY=sk-your-key" >> .env
```

Install dependencies once:

```bash
bun install
```

## Quick start

```bash
bun run src/cli.ts \
  --repo /path/to/repo \
  "Ship a hello-world web page with one button."
```

Two developers are provisioned by default (`Developer 1`, `Developer 2`). Each
receives a worktree (`agents/dev-1`, `agents/dev-2`), an `AGENT_TASKS.md`, and a
`STATUS.md`. The Project Manager owns the shared `PROJECT_OVERVIEW.md` and
`TEAM_STATUS.md` files at the repository root.

### Custom rosters

Use `--developer` to declare specific team members:

```bash
bun run src/cli.ts \
  --repo /path/to/repo \
  --developer "name=Developer Alpha,branch=agents/alpha" \
  --developer "name=Developer Beta,branch=agents/beta,description=Backend specialist" \
  "Implement the new onboarding experience"
```

Without `--developer`, the `--developer-count` flag controls how many default
developers are created (minimum 1).

### What the CLI does

1. Ensures `.wtm` exists (invokes `wtm init` if needed).
2. Verifies or creates a worktree per developer (`wtm worktree add <branch>`).
3. Starts the Codex MCP server (`npx codex mcp-server` by default).
4. Instantiates the Project Manager + Developer agents with the OpenAI Agents SDK.
5. Runs the session via `Runner.run`, keeping the Project Manager in charge of
   assignments and handoffs.

["Building Consistent Workflows with Codex CLI & Agents SDK"]: https://cookbook.openai.com/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk
