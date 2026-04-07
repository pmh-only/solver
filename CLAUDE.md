# solver

Discord.js user-installable interaction bot. Single slash command `/c` with a required string option `_` that routes to subcommands via autocomplete.

## Stack

- Node.js ESM, TypeScript, tsx for dev
- discord.js 14, Components V2 (`MessageFlags.IsComponentsV2`)
- pnpm

## Scripts

```
pnpm dev       # run with tsx (no build needed)
pnpm build     # tsc compile → dist/
pnpm start     # run compiled dist/index.js
pnpm deploy    # force-register /c globally via REST
pnpm lint      # eslint src
pnpm format    # prettier --write src
```

## File map

```
src/
  index.ts        # entry: ensureDeployed, client, all interaction routing
  deploy.ts       # standalone force-deploy (used by pnpm deploy)
  types.ts        # Subcommand, FlagDef interfaces
  flags.ts        # parseFlags(input) → { bare, flags }
  components.ts   # container(), TopLevelComponent, PUB_BUTTON_ID
  commands/
    ping.ts       # example subcommand
```

## Adding a subcommand

**Step 1** — create `src/commands/<name>.ts`:

```ts
import type { Subcommand } from '../types.js'
import { container } from '../components.js'

export const subcommand: Subcommand = {
  name: 'example',
  description: 'one-line description',

  // optional: declare command-specific flags (shown in autocomplete)
  flags: {
    verbose: { description: 'enable verbose output' },           // boolean flag
    format:  { description: 'output format', value: 'string' }, // value flag
  },

  // optional: return extra autocomplete choices for the args position
  // does NOT call interaction.respond() — just returns choices
  async autocomplete(restArgs, flags) {
    return [{ name: 'ping suggestion', value: 'example suggestion' }]
  },

  // args = bare input (flags stripped), flags = parsed Map
  async execute(interaction, args, flags) {
    await interaction.reply(container(args, flags, 'output here'))
  },
}
```

**Step 2** — register in `src/index.ts`, add to the `for...of` array:

```ts
import { subcommand as example } from './commands/example.js'
// ...
for (const sub of [ping, example]) {
```

No deploy needed — subcommands are routed in-process. Only `/c` itself needs to be registered (handled by `ensureDeployed` on startup).

## container(args, flags, ...components)

Builds a Components V2 reply object ready to pass to `interaction.reply()` / `followUp()`.

| param | type | description |
|---|---|---|
| `args` | `string` | bare input (flags stripped) — shown in footer |
| `flags` | `Flags` | parsed flags map — all flags rendered in footer; `--pub` makes non-ephemeral |
| `...components` | `TopLevelComponent[]` | strings auto-wrapped in `TextDisplayBuilder` |

- Footer (`-# \`args --flags\``) appended to last `TextDisplayBuilder` if present, else new one added
- Without `--pub`: ephemeral + pub button appended
- With `--pub`: non-ephemeral, no pub button

```ts
type TopLevelComponent =
  | string
  | TextDisplayBuilder | ContainerBuilder | SeparatorBuilder
  | SectionBuilder | MediaGalleryBuilder | ActionRowBuilder<ButtonBuilder>
```

## Flag system

`parseFlags(input)` strips `--key` and `--key value` tokens from input:

```ts
parseFlags('ping hello --pub --format json')
// → { bare: 'ping hello', flags: Map { pub → true, format → 'json' } }
```

`args` passed to `execute` and `container` is always `bare` (flags removed).  
`flags` map is passed separately.

**Global flag:** `--pub` — publishes response (non-ephemeral, no pub button).

## Pub button

The pub button (`customId: 'pub'`) is handled in `index.ts`. When clicked it:
1. Reads `interaction.message.components`
2. Filters out the `ActionRow` containing the pub button
3. Replies with the remaining components as a new non-ephemeral message

## Interaction routing (index.ts)

```
InteractionCreate
  ├── isButton && customId === 'pub'  → re-send message publicly
  ├── isAutocomplete && commandName === 'c'
  │     ├── focused ends with '--...' in args position → flag completion
  │     ├── inArgs (space after subcommand)            → subcommand.autocomplete() + flags
  │     └── subcommand selection mode                  → scored name matching
  └── isChatInputCommand && commandName === 'c'
        → parseFlags → route to subcommand.execute(interaction, bare, flags)
```

### Autocomplete details

- **Flag completion** (`ping --pu`): suggests full strings like `ping hello --pub`
- **Args mode** (`ping `): calls `sub.autocomplete(restArgs, flags)` (returns choices array, never calls `respond()`), then appends subcommand flags + `--pub` as full-string suggestions
- **Selection mode** (`pi`): scores exact=3, prefix=2, includes=1, subsequence=0; `name === value`

## Env

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
```

On startup, `ensureDeployed()` fetches global app commands and only registers `/c` if it is not already present. Use `pnpm deploy` to force re-register (e.g. after changing the command definition).
