# Listing ProjectTracker in the Claude and ChatGPT directories

ProjectTracker is a remote MCP server with OAuth sign-in. People add it to Claude or ChatGPT, sign in, choose a workspace and whether
the assistant may make changes. This page holds everything the two directory forms ask for.

## Server facts

| | |
|---|---|
| MCP server URL | `https://projecttracker.in/api/v1/mcp` (Streamable HTTP, JSON-RPC over POST) |
| Sign-in | OAuth 2.1, authorization code with PKCE (S256), dynamic client registration, rotating refresh tokens |
| Discovery | `/.well-known/oauth-protected-resource/api/v1/mcp`, `/.well-known/oauth-authorization-server` |
| Endpoints | `/oauth/register`, `/oauth/authorize` (consent page at `/connect`), `/oauth/token`, `/oauth/revoke` |
| Scopes | `mcp:read` (always), `mcp:write` (when the person allows changes) |
| Access token | 1 hour; refresh token 60 days, rotated on every use; disconnecting ends both at once |
| Plans | Every plan, including Free |
| Callback URLs | Any https address the client registers (Claude: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`; ChatGPT: its registered callback) |
| Privacy policy | `https://projecttracker.in/privacy` |
| Terms | `https://projecttracker.in/terms` |
| Support | `support@projecttracker.in` |
| Documentation | `https://projecttracker.in/features/connect-ai/` |

## Tools

All tools carry `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint: false` (they act only inside the workspace).
Results are capped at 40,000 characters (well under 25,000 tokens).

| Tool | Read only | Purpose |
|---|---|---|
| `list_projects` | yes | Projects the person can see |
| `get_project` | yes | One project's details |
| `list_project_tasks` | yes | A project's tasks |
| `my_work` | yes | Everything assigned to the person |
| `get_task` | yes | One task |
| `list_work_items` | yes | Operations: tickets and requests with service level |
| `search_api_docs` | yes | Published API documentation (sensitive values masked) |
| `create_task` | no | Create a task |
| `update_task_status` | no | Move a task to a status |
| `add_task_comment` | no | Comment on a task |
| `log_time` | no | Log time on a task |
| `create_work_item` | no | Create an operational work item |
| `update_work_item_status` | no | Change a work item's status |

## Example prompts (the forms ask for at least three)

1. **"What is overdue for me this week, grouped by project?"**: calls `my_work` with `overdue: true` and lists the items with project and due date.
2. **"Create a task in Customer portal to review the login copy, due Friday, high priority."**: calls `list_projects` to find the project, then `create_task`. Needs "Read and make changes".
3. **"Which support tickets are close to missing their target?"**: calls `list_work_items` and lists open items whose service level is at risk.
4. **"Find the API endpoint that creates a payment and tell me its required fields."**: calls `search_api_docs`.

## Test account for reviewers

Reviewers need an account that works without two-step verification, with sample data:

1. Register `reviewer@projecttracker.in` (a mailbox you control), verify the e-mail, and create the workspace "Directory Review".
2. Add two projects with a few tasks (some overdue, assigned to the reviewer), two work items in Operations, and one API document with a published endpoint.
3. Do not turn on two-step verification or an IP allowlist for this workspace. Keep the account active after approval.
4. Give the reviewers the e-mail and password in the form only.

## Before submitting

- Anthropic: submission form linked from the [remote MCP server submission guide](https://support.claude.com/en/articles/12922490). Allow Claude's published IP addresses if a firewall or bot filter sits in front of the site.
- OpenAI: complete organization (business) verification on platform.openai.com, then submit through the plugin portal (platform.openai.com/plugins): add the MCP URL, choose OAuth, select **Scan Tools**, fill in the listing and the test prompts above.
- Test the whole flow from Claude.ai, Claude Desktop and ChatGPT first: add the connector, sign in, approve, run the four prompts, disconnect from Settings › Connected apps and check the assistant is asked to sign in again.
