# Feature Agent Instructions - solver

Use this guide when implementing or changing features in this repository. Read the relevant source and neighboring tests before editing; do not infer behavior from the README.

## Project Model

`solver` is a Node.js 24, TypeScript, Discord.js bot. Discord exposes one `/c` slash command whose required `_` option contains an internal subcommand and its arguments. The bot also exposes user and message context-menu commands.

The main flow is:

```text
Discord interaction
  -> src/handler.ts
  -> parseFlags() and subcommand lookup
  -> Subcommand.execute()
  -> Components V2 response
  -> optional SQLite state
```

Important files:

```text
src/index.ts                  subcommand registration and bot startup
src/application-commands.ts   Discord-visible slash/context commands
src/handler.ts                central interaction router and autocomplete
src/types.ts                  Subcommand and command result contracts
src/flags.ts                  flag parsing and aliases
src/components.ts             Components V2 builders and reply lifecycle
src/commands/                 command and interaction implementations
src/helpers/kv-store.ts       synchronous SQLite key/value storage
src/test/e2e.ts               raw Discord JSON -> captured REST calls harness
src/test/*.test.ts            Vitest feature and regression tests
```

Use `.js` suffixes for relative imports. The project is native ESM with Node16 module resolution and strict TypeScript.

## Feature Workflow

For every feature change:

1. Read the affected command, `src/handler.ts`, `src/components.ts`, and the closest tests.
2. Make the smallest change that implements the requested behavior.
3. Add or update focused automated tests in `src/test/<feature>.test.ts`.
4. Run `pnpm test`.
5. Run `pnpm lint`.
6. Run `pnpm exec tsc --noEmit`.
7. Commit the completed change and push the tracked branch without waiting for the user to request it.

Do not run `pnpm deploy` as verification. It replaces the application's global Discord command set. Do not start the bot without explicit permission because startup connects to Discord and may deploy missing commands.

## Adding A Subcommand

Create substantial commands in `src/commands/<name>.ts`. Keep parsing or protocol code in a separate runtime module when it can be tested without Discord. Add only small, closely related utilities to `src/commands/more.ts`; do not make that module a default dumping ground.

Every subcommand implements `Subcommand` from `src/types.ts`:

```ts
export interface Subcommand {
  name: string
  description: string
  usage?: string
  examples?: string[]
  flags?: Record<string, FlagDef>
  autocomplete?: (restArgs: string, flags: Flags) => Promise<Choice[]>
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
- Remember that changing an existing command definition is not detected by startup's name/type-only deployment check; a real deployment requires an explicit `pnpm deploy` later.

## Persistence

`src/helpers/kv-store.ts` is a process-wide, synchronous SQLite key/value store. There is one global keyspace.

- Prefix internal keys with `<feature>:` and use random tokens where practical.
- Scope user-private or guild-private data by the relevant Discord ID.
- Parse stored JSON defensively and handle missing/corrupt state as expired.
- Never persist credentials, raw environment values, or unnecessary interaction tokens.
- Add bounded retention or cleanup for transient state instead of allowing unlimited growth.
- If a new internal prefix could appear in `list`, add it to the filtering policy in `src/commands/list.ts` and test that it stays hidden.
- Clear stored values and reset mocks/timers in tests so cases remain isolated.
- Avoid repeated synchronous database operations inside large loops or latency-sensitive handlers.

## Security And Resource Limits

Treat all Discord arguments, message content, component IDs, URLs, files, and stored values as untrusted.

- Do not add shell execution, dynamic evaluation, or arbitrary process access to a feature.
- For network features, use explicit timeouts, cap downloaded bytes, validate redirects, and block loopback, link-local, private, and cloud-metadata destinations unless the feature explicitly requires trusted internal access.
- Do not include authorization headers, credentials, interaction tokens, or sensitive stored data in public responses or logs.
- Add rate, concurrency, output-size, and cost controls for OpenAI or other metered APIs.
- Avoid unbounded regular expressions, buffers, canvas dimensions, collections, timers, and follow-up messages.
- Load credentials from environment variables and document new variables in `.env.example` with placeholder values only.
- Route authentication callbacks for any future MCP through an endpoint on the existing web server, following `/mcp/spotify/callback`; do not expose a separate public listener.
- Do not rely on `node:vm`, Discord ephemeral responses, or Docker's non-root user as a security boundary.

## Testing

Tests use Vitest and the harness in `src/test/e2e.ts`. The normal pattern sends raw Discord interaction JSON through the production handler and inspects captured REST calls.

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

## Absolute Rules

- Never expose a new feature only in source; register every entrypoint and route every interaction it needs.
- Never forget that command `args` starts with the subcommand name.
- Never detect autocomplete argument mode with `bare.includes(' ')`; use `focused.includes(' ')` because flags are stripped from `bare`.
- Never pass the full `container()` or `commandContainer()` result to `editReply()`; pass its `components` and `MessageFlags.IsComponentsV2`.
- Never use `ephemeral: true`; use `MessageFlags.Ephemeral`.
- Cast `Buffer.concat([...])` to `Buffer` where TypeScript 6 requires it.
- Never make real Discord, OpenAI, IMAP, Firecrawl, or arbitrary internet calls from tests.
- Never finish a code feature without focused tests and passing test, lint, and type-check commands.
- Never leave completed work uncommitted or unpushed. Commit and push automatically without asking the user for permission.
