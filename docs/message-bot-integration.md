# Original message commands

The message commands from `pmh-only/bot`, commit
`20a90a1af9caa2560d70b972d9ff07378abccdf3`, are ported in
`src/commands/message-bot/core.ts`. Their parsing, dispatch order, calculations,
random-food selection, saved-reply attribution, and normal response strings are
preserved. This is separate from the existing `/c` and standalone slash commands.
The upstream MIT notice is in [community-integration.md](community-integration.md#upstream-license).

Everyone in a bot-installed guild can use:

- `!!help`, `!!ping`, `!!now`, `!!pizza`
- `!!1 usd to krw` or `!!1usd to krw`
- `점메추`, `저메추`
- `!!set greeting hello`, followed by `!!greeting`
- `!!set greeting` to delete a saved reply
- `!!list` for sorted saved-reply keys

The original case-sensitive, space-based matching is intentional. Only `help`
and `list` are reserved by the command core. Zero/invalid currency results stay
silent. Saved replies retain the original `-# <@authorId>` footer, but mentions
and reply notifications never ping anyone.

## Configuration

Use `/a` and `manage_community_settings`. There is one global configuration;
no server ID is required:

- `messageCommands: { enabled: true, prefix: '!!' }` is the default.
- Change `prefix` or set `enabled: false` without restarting.
- `foods` configures the shared food menu; null restores the original menu.
- `action: 'reset-message-replies'` clears only the message-command
  records, including corrupt-data recovery. It does not clear `/c` variables.

Message commands require the already-used Guild Messages and Message Content
gateway intents, plus the bot's View Channel and Send Messages permissions.
They are handled before role chat, so a command does not also receive a random
AI answer. Bots, webhooks, system messages, and DMs are excluded.

## Integration boundaries

The core receives per-request dependencies rather than global prefix, filesystem,
or fetch state. The runtime adapter replaces `data/set.json` with server-isolated
SQLite records under `community:message-bot:<guildId>`. A live synchronous view
prevents overlapping requests from overwriting stale snapshots. Saved commands
never read or write `/c` variables or environment settings. Internal records are
hidden from `/c list` and shorthand lookup.

Only the original PizzINT endpoint and jsDelivr currency-data paths are allowed.
Requests reject redirects, time out after 10 seconds, cap downloads at 1 MiB,
and use the existing bounded transfer helper. No external request is made by
tests. Replies are capped at Discord's 2,000-character limit; storage is capped
at 1,000 records / 3 MiB per guild, and prototype-key writes are rejected.
These are adapter safeguards, not replacements for the upstream command logic.
