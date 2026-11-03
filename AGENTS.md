# Repository Agent Instructions - solver

Use this guide when implementing or changing features in this repository. Read the relevant source and neighboring tests before editing; do not infer behavior from the README.

## Project Model

`solver` is a Node.js 24, TypeScript 6, Discord.js bot with an AI agent and an HTTP web interface. It exposes `/a` for the agent, `/c` for internal utility subcommands, guild-only community slash commands, and user/message context-menu commands. The required `_` option of `/c` contains the internal subcommand and its arguments.

The main flow is:

```text
Discord interaction
  -> DiscordFeatureRegistry (priority-ordered, first matching feature)
  -> agent / community / additional feature
  -> feature handler (src/handler.ts for agent and additional interactions)
  -> command or component handler
  -> Discord response and optional persisted state

/c command
  -> parseFlags() and subcommand lookup
  -> Subcommand.execute() -> Components V2 response

Gateway messages/reactions -> message-handler.ts / reaction-forward.ts
HTTP requests -> web-server.ts -> authentication, agent, settings, archive search
```

Important files:

```text
src/index.ts                  subcommand registration and bot startup
src/features.ts               built-in feature registration and matchers
src/feature-registry.ts       feature priority, command restrictions, dispatch
src/dynamic-features.ts       persisted agent-created Discord features
src/application-commands.ts   Discord-visible slash/context commands
src/application-command-deployment.ts  command replacement and recovery
src/community-feature.ts      guild-only community interaction routing
src/community-settings.ts     persisted community configuration
src/handler.ts                central interaction router and autocomplete
src/types.ts                  Subcommand and command result contracts
src/flags.ts                  flag parsing and aliases
src/components.ts             Components V2 builders and reply lifecycle
src/commands/                 command and interaction implementations
src/agent/                    agent runtime, sessions, streaming, MCP, tools
src/message-handler.ts        gateway message routing
src/role-chat.ts              persona-based message conversations
src/discord-archive*.ts        archive storage, live capture, history backfill
src/archive-search*.ts         archive queries and web search adapter
src/web-server.ts             HTTP routes and existing OAuth callbacks
src/web-auth.ts               web login, session cookies, CSRF
src/web-ui.ts                 embedded web frontend assets
src/authorization.ts          administrator authorization
src/runtime-health.ts         runtime issue reporting
src/helpers/kv-store.ts       synchronous SQLite key/value storage
src/helpers/environment-store.ts  restore agent-managed environment settings
src/helpers/interaction-routes.ts  persisted interaction routing helpers
src/test/e2e.ts               raw Discord JSON -> captured REST calls harness
src/test/*.test.ts            Vitest feature and regression tests
```

Use `.js` suffixes for relative imports. The project is native ESM with Node16 module resolution and strict TypeScript. Use pnpm (the version is pinned in `package.json`). Follow neighboring formatting; `pnpm format` and `pnpm format:check` target `src`, not Markdown.

## Feature Workflow

For every feature change:

1. Check `git status` and preserve unrelated user changes. Read the affected implementation, its routing/registration, and the closest tests. For command changes, also read `src/handler.ts` and `src/components.ts`.
2. Make the smallest change that implements the requested behavior.
3. Add or update focused automated tests in `src/test/<feature>.test.ts`.
4. Run `pnpm test`.
5. Run `pnpm lint`.
6. Run `pnpm exec tsc --noEmit`.
7. Commit the completed change and push the tracked branch without waiting for the user to request it.

Do not run `pnpm deploy` as verification. It replaces the application's global Discord command set. Do not start the bot without explicit permission because startup connects to Discord and may deploy missing commands.

`pnpm start`, `pnpm dev`, and `pnpm dev:watch` all start the live application; do not use them as smoke tests. Importing `src/index.ts` also performs startup side effects. `pnpm build` compiles TypeScript without starting the bot. For documentation-only changes, verify the instructions against source and run `git diff --check`; no new feature tests are needed.

## Routing, Access, And Configuration

- Built-in features are registered in `src/features.ts`. Matchers run in descending priority; the additional feature is a catch-all. A new independent feature needs both command definitions and a registered matcher/handler, not just an export.
- Community slash commands are defined in `src/community-application-commands.ts` and routed through `src/community-feature.ts`, not the `/c` subcommand collection.
- Application commands default to `default_member_permissions: '0'` through `restrictApplicationCommands`; community commands explicitly opt out. Discord command visibility is not a substitute for runtime authorization.
- `src/handler.ts` restricts private utility/agent interactions to configured administrators, with explicit exceptions for public source messages and constrained pubtab interactions. Preserve per-feature ownership checks even when central routing allows an interaction.
- Every new feature must be fully configurable through `/a`, without requiring new environment variables or terminal operations. Reuse existing settings, agent tools, and stores rather than introducing a second configuration path.
- Agent entrypoints are exported through `src/agent/index.ts` and `src/agent/runtime.ts`; implementation is split across Discord/web runtimes, session storage/privacy, streaming, and MCP runtime modules. Keep changes in the responsible module instead of expanding the export facade.
- Startup restores stored environment settings before requiring Discord credentials and administrator IDs. Treat stored configuration, credentials, and agent tool access as privileged; do not expose them through ordinary commands or public sessions.

## Adding A Subcommand

Create substantial commands in `src/commands/<name>.ts`. Keep parsing or protocol code in a separate runtime module when it can be tested without Discord. Add only small, closely related utilities to `src/commands/more.ts`; do not make that module a default dumping ground.

Every subcommand implements `Subcommand` from `src/types.ts`:

```ts
export interface Subcommand {
  name: string
  description: string
  usage?: string
  examples?: string[]
  pubtab?: { label: string; args: string; direct?: boolean }
  flags?: Record<string, FlagDef>
  autocomplete?: (restArgs: string, flags: Flags) => Promise<{ name: string; value: string }[]>
  execute: (interaction: CommandInteraction, args: string, flags: Flags) => Promise<void>
  run?: (args: string, flags: Flags) => Promise<CommandRunResult>
}
```

Follow these rules:

- Include concise `usage` and realistic `examples`; they appear in command controls.
- `args` passed to `execute` and `run` includes the subcommand name. Strip it with `args.replace(/^\S+\s*/, '').trim()` before treating it as user input.
- `autocomplete` receives only arguments after the subcommand name.
- Declare value-taking flags with `value: 'string'`; flags without `value` are booleans.
- The global `--pub` / `-p` flag is supplied by the router and must not be redeclared.
- Register a dedicated command by importing it and adding it to the collection in `src/index.ts`.
- Register a small command exported through `extraSubcommands` in `src/commands/more.ts`.
- Add `pubtab` metadata only after confirming a command is safe to launch publicly with constrained input; registered commands with that metadata are added to the tab automatically.

The flag parser is whitespace-based, not shell-aware. Boolean flags may consume a following bare token in surprising ways, and quoted values are not preserved as shell tokens. Test the exact supported syntax, especially aliases and value flags.

## Command Response Pattern

Use the helpers in `src/components.ts` rather than assembling ordinary command responses manually:

- `commandContainer(subcommand, args, flags, ...)` builds a command response with usage, examples, retry, edit, pin, and publish controls.
- `sendCommandReply(interaction, payload)` handles initial replies, component updates, deferred edits, command-input persistence, and ephemeral deletion.
- `runRerunnableCommand(...)` is the preferred path for asynchronous or retryable work.
- `commandReferenceReply(...)` renders validation and usage errors.
- `summarySection`, `text`, `separator`, `codeBlock`, `bulletBlock`, and `keyValueBlock` build response content.
- `container(...)` is for generic/system responses that do not need command controls.

Preferred rerunnable structure:

```ts
import type { Subcommand } from '../types.js'
import {
  commandReferenceReply,
  runRerunnableCommand,
  sendCommandReply,
  summarySection
} from '../components.js'

export const subcommand: Subcommand = {
  name: 'example',
  description: 'describe the result',
  usage: 'example <value> [--pub]',
  examples: ['example value'],

  async run(args, flags) {
    const input = args.replace(/^\S+\s*/, '').trim()
    const result = await doWork(input, flags)
    return summarySection('Example', [result])
  },

  async execute(interaction, args, flags) {
    const input = args.replace(/^\S+\s*/, '').trim()
    if (!input) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(subcommand, args, flags, 'usage', 'value is required')
      )
      return
    }

    await runRerunnableCommand(interaction, subcommand, args, flags, () =>
      subcommand.run!(args, flags)
    )
  }
}
```

Response invariants:

- Commands are ephemeral by default and public only when `flags.has('pub')`.
- Components V2 replies and updates require `MessageFlags.IsComponentsV2`.
- Deferred replies may use `MessageFlags.Ephemeral`, but deferred edits must use `MessageFlags.IsComponentsV2` and pass `components`, not the entire `container()` result.
- Do not use `interaction.reply({ content: '...' })` for normal feature output. Existing plain-text paths are intentional compatibility behavior, not a template for new commands.
- Private replies are scheduled for deletion after 60 seconds. Use the shared send helpers so that pinning and deletion remain consistent.
- Preserve Discord limits. Truncate external/user content and avoid oversized component trees, select menus, and message bodies.

## Interactive Features

Buttons, selects, modals, games, and context menus require explicit central routing.

For component interactions:

- Namespace every custom ID with a feature-specific exported prefix.
- Include an opaque random token when the ID addresses persisted state.
- Export an `is<Feature>...Id()` predicate and a focused handler from the feature module.
- Import and route the predicate/handler in `src/handler.ts` before generic command controls.
- Validate custom-ID structure and persisted JSON before use.
- Return an ephemeral Components V2 "expired" response for missing or malformed state.
- Enforce initiating-user or participant ownership when the interaction is not intentionally shared.
- Use `interaction.update()` for immediate message replacement and `deferUpdate()` before slow work.
- Test duplicate clicks, unauthorized users, malformed IDs, expired state, and public/private behavior when applicable.

For context-menu features:

- Define the Discord-visible command in `src/application-commands.ts`.
- Put implementation and exported command/custom IDs in a focused file under `src/commands/`.
- Add the matching user, message, modal, button, or select branch in `src/handler.ts`.
- Startup compares command count, name/type, permissions, contexts, integration types, descriptions, and selected option fields using `areApplicationCommandsCurrent()`. It is not a complete deep comparison of every Discord field. Update deployment tests when changing definitions or synchronization behavior; do not deploy as part of verification.

## Persistence

`src/helpers/kv-store.ts` is a process-wide, synchronous SQLite key/value store. There is one global keyspace.

The default production path is `data/kv.sqlite`; `KV_STORE_PATH` overrides it. Tests default to worker-specific files under `.tmp/`. Archive storage and agent memory have separate implementations; do not assume all persisted data belongs in the KV store.

- Prefix internal keys with `<feature>:` and use random tokens where practical.
- Scope user-private or guild-private data by the relevant Discord ID.
- Parse stored JSON defensively and handle missing/corrupt state as expired.
- Never copy credentials, raw environment values, or unnecessary interaction tokens into command/session state. Existing privileged configuration stores intentionally persist secrets; use their APIs only for the intended configuration flow and never return their contents publicly.
- Add bounded retention or cleanup for transient state instead of allowing unlimited growth.
- Register new internal prefixes in `INTERNAL_KEY_PREFIXES` in `src/helpers/kv-store.ts`. The shared `isInternalStoredKey()` policy protects listing, direct stored-value lookup, and other utility paths; test that internal state stays hidden.
- Clear stored values and reset mocks/timers in tests so cases remain isolated.
- Avoid repeated synchronous database operations inside large loops or latency-sensitive handlers.

## Security And Resource Limits

Treat all Discord arguments, message content, component IDs, URLs, files, and stored values as untrusted.

- Do not add shell execution, dynamic evaluation, or arbitrary process access to an ordinary feature. Existing privileged agent tools and `run`/`sh` commands are intentional exceptions, not templates for new commands; do not broaden their authorization or capabilities incidentally.
- For network features, use explicit timeouts, cap downloaded bytes, validate redirects, and block loopback, link-local, private, and cloud-metadata destinations unless the feature explicitly requires trusted internal access.
- Do not include authorization headers, credentials, interaction tokens, or sensitive stored data in public responses or logs.
- Add rate, concurrency, output-size, and cost controls for OpenAI or other metered APIs.
- Avoid unbounded regular expressions, buffers, canvas dimensions, collections, timers, and follow-up messages.
- Reuse existing privileged credential/configuration APIs. Do not add required environment variables for a new feature; if an existing bootstrap variable is changed, keep `.env.example` accurate with placeholders only.
- Route authentication callbacks for any future MCP through an endpoint on the existing web server, following `/mcp/spotify/callback`; do not expose a separate public listener.
- Do not rely on `node:vm`, Discord ephemeral responses, or Docker's non-root user as a security boundary.
- For HTTP changes, preserve authentication, CSRF validation on mutations, request-body limits, rate limits, and security headers. Keep hosted/untrusted HTML sandboxed and separate from authenticated UI behavior.
- For agent, archive, and persona changes, preserve user/session/guild isolation across both Discord and web entrypoints. Filter private data before it reaches model context, tools, public replies, or archive search results.
- Report operational failures through existing runtime-health and safe-error helpers where applicable; avoid leaking secrets through raw external-service errors.

## Testing

Tests use Vitest and the harness in `src/test/e2e.ts`. The normal pattern sends raw Discord interaction JSON through the production handler and inspects captured REST calls.

The interaction harness dispatches through the production feature registry. It also offers `dispatchMessage()` for gateway messages; runtime/protocol and HTTP tests use focused mocks or local test servers as appropriate. `src/test/setup.ts` supplies the default test administrator and timezone before each test.

```ts
const subs = makeSubcommands(subcommand)
const calls = await dispatch(commandJSON('example value'), subs)
const callback = getCallback(calls)
const edit = getEdit(calls)
```

Add the cases relevant to the feature:

- Immediate reply path.
- Deferred/edit path for asynchronous work.
- Ephemeral default and non-ephemeral `--pub` behavior.
- Usage or validation failure.
- Subcommand and argument autocomplete.
- Long and short flag forms.
- Retry and edit controls for rerunnable commands.
- Component, select, and modal routing.
- Persisted-state success, corruption, expiration, isolation, and ownership.
- External-service success, timeout, malformed response, and failure.
- Output truncation and Discord limits.

Mock network and paid services. Use fake timers for deletion or timer behavior. Put protocol parsing, calculation, and formatting in testable runtime functions when practical. Do not weaken assertions merely to make an existing failure pass.

Use `pnpm exec vitest run src/test/<feature>.test.ts` while iterating, then run the full required checks. Restore environment changes, network stubs, mocks, timers, database state/connections, and local servers so tests cannot contaminate other cases. Follow `src/helpers/kv-store-test.ts` and neighboring tests for temporary database isolation; never point tests at production data.

## Absolute Rules

- Never modify `README.md`.
- Every feature must be fully configurable through `/a` and must not require additional environment variables or terminal operations.
- Never expose a new feature only in source; register every entrypoint and route every interaction it needs.
- Never forget that command `args` starts with the subcommand name.
- Never detect autocomplete argument mode with `bare.includes(' ')`; use `focused.includes(' ')` because flags are stripped from `bare`.
- Never pass the full `container()` or `commandContainer()` result to `editReply()`; pass its `components` and `MessageFlags.IsComponentsV2`.
- Never use `ephemeral: true`; use `MessageFlags.Ephemeral`.
- Cast `Buffer.concat([...])` to `Buffer` where TypeScript 6 requires it.
- Never make real Discord, OpenAI, IMAP, Firecrawl, or arbitrary internet calls from tests.
- Never finish a code feature without focused tests and passing test, lint, and type-check commands.
- Never leave completed work uncommitted or unpushed. Commit and push automatically without asking the user for permission.
