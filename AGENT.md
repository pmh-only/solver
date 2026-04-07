# Agent Instructions — solver

You are working on a Discord.js bot. Follow every rule here exactly. Do not skip steps.

---

## MANDATORY WORKFLOW

Every time you change code, do these steps **in order**. Do not skip any step.

```
1. Write or update code
2. Write or update tests in src/test/<name>.test.ts
3. Run: pnpm test      ← must pass, fix failures before continuing
4. Run: pnpm lint      ← must pass, fix all errors before continuing
5. Commit your changes
6. Push your branch
```

**Never finish a task without passing both `pnpm test` and `pnpm lint`, then committing and pushing the result.**

---

## ABSOLUTE RULES

**NEVER** do these:

- Use `interaction.reply({ content: '...' })` — always use Components V2 (`container()`)
- Use `ephemeral: true` — always use `flags: MessageFlags.Ephemeral`
- Pass `container()`'s return value to `editReply()` — it breaks (see below)
- Use `bare.includes(' ')` to detect args mode in autocomplete — use `focused.includes(' ')`
- Forget to strip the subcommand name from `args` before using it as user input

**ALWAYS** do these:

- Use `container(args, flags, 'your output')` for all replies
- Use `MessageFlags.IsComponentsV2` on every `editReply` / non-deferred `reply`
- Cast `Buffer.concat([...])` to `Buffer` — TypeScript 6 requires it
- Write tests for every subcommand in `src/test/<name>.test.ts`
- Run `pnpm test` and `pnpm lint` before finishing
- Commit and push after the work is complete

---

## WRITING TESTS

Tests use `src/test/e2e.ts`. The pattern is: raw Discord JSON in → captured REST JSON out.

```ts
import { describe, it, expect } from 'vitest'
import { InteractionResponseType, MessageFlags } from 'discord.js'
import { subcommand as myCmd } from '../commands/mycommand.js'
import {
  commandJSON,
  autocompleteJSON,
  dispatch,
  getCallback,
  getEdit,
  makeSubcommands
} from './e2e.js'

const subs = makeSubcommands(myCmd)

describe('mycommand — command', () => {
  it('replies immediately for simple case', async () => {
    const calls = await dispatch(commandJSON('mycommand'), subs)
    const body = getCallback(calls) as { type: number; data: { flags: number } }
    expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource)
  })

  it('defers then edits for slow case', async () => {
    const calls = await dispatch(commandJSON('mycommand somearg'), subs)
    const defer = getCallback(calls) as { type: number }
    const edit = getEdit(calls)
    expect(defer.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource)
    expect(edit).not.toBeNull()
  })

  it('defers publicly with --pub', async () => {
    const calls = await dispatch(commandJSON('mycommand somearg --pub'), subs)
    const defer = getCallback(calls) as { type: number; data: { flags: number } }
    expect(defer.data.flags & MessageFlags.Ephemeral).toBeFalsy()
  })
})

describe('mycommand — autocomplete', () => {
  it('returns choices in selection mode', async () => {
    const calls = await dispatch(autocompleteJSON('my'), subs)
    const body = getCallback(calls) as { type: number; data: { choices: { value: string }[] } }
    expect(body.type).toBe(InteractionResponseType.ApplicationCommandAutocompleteResult)
    expect(body.data.choices.length).toBeGreaterThan(0)
  })
})
```

**Minimum test coverage per subcommand:**

- Immediate reply (no defer)
- Deferred reply (if the command defers)
- `--pub` flag makes response non-ephemeral
- Autocomplete selection mode returns the subcommand name

---

## ADDING A SUBCOMMAND — STEP BY STEP

### Step 1: Create `src/commands/<name>.ts`

```ts
import { MessageFlags } from 'discord.js'
import type { Subcommand } from '../types.js'
import { container } from '../components.js'

export const subcommand: Subcommand = {
  name: 'example',
  description: 'one-line description',

  flags: {
    myflag: { description: 'flag description', value: 'string' }, // value flag
    verbose: { description: 'verbose output' } // boolean flag
  },

  async autocomplete(restArgs, flags) {
    return [{ name: 'suggestion', value: 'example suggestion' }]
  },

  async execute(interaction, args, flags) {
    // !! args includes the subcommand name as the first word — strip it:
    const restArgs = args.replace(/^\S+\s*/, '').trim()

    if (restArgs) {
      // Slow path: defer first, then edit
      await interaction.deferReply({ flags: flags.has('pub') ? undefined : MessageFlags.Ephemeral })
      const result = await doSlowWork(restArgs)
      const reply = container(args, flags, result)
      await interaction.editReply({
        components: reply.components,
        flags: MessageFlags.IsComponentsV2
      })
    } else {
      // Fast path: reply immediately
      await interaction.reply(container(args, flags, 'result here'))
    }
  }
}
```

### Step 2: Register in `src/index.ts`

```ts
import { subcommand as example } from './commands/example.js'
// add to the array:
for (const sub of [ping, example]) {
```

### Step 3: Write tests in `src/test/<name>.test.ts`

Use the test pattern shown in WRITING TESTS above.

### Step 4: Run and verify

```
pnpm test   ← all tests must pass
pnpm lint   ← no errors allowed
```

---

## KEY PATTERNS

### Reply immediately (no async work)

```ts
await interaction.reply(container(args, flags, 'output'))
```

### Reply after async work (defer first)

```ts
await interaction.deferReply({ flags: flags.has('pub') ? undefined : MessageFlags.Ephemeral })
const result = await someAsyncWork()
const reply = container(args, flags, result)
await interaction.editReply({ components: reply.components, flags: MessageFlags.IsComponentsV2 })
//                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                            NEVER pass container() directly to editReply — extract components
```

### Strip subcommand name from args

```ts
// args = "example foo bar"  ← includes subcommand name
const restArgs = args.replace(/^\S+\s*/, '').trim()
// restArgs = "foo bar"
```

### Buffer.concat cast

```ts
const buf = Buffer.concat([a, b, c]) as Buffer // ← cast required in TypeScript 6
```

---

## FLAGS API CHEAT SHEET

| Method                  | Allowed flags                                           |
| ----------------------- | ------------------------------------------------------- |
| `deferReply({ flags })` | `MessageFlags.Ephemeral` only                           |
| `editReply({ flags })`  | `MessageFlags.IsComponentsV2` only                      |
| `reply({ flags })`      | `MessageFlags.IsComponentsV2 \| MessageFlags.Ephemeral` |
| `container()`           | handles flags automatically — use for `reply()` only    |

---

## FILE MAP

```
src/
  index.ts          # bot entry point — registers client and routes interactions
  handler.ts        # interaction handler logic (imported by index.ts and tests)
  deploy.ts         # force-deploy slash command
  types.ts          # Subcommand, FlagDef types
  flags.ts          # parseFlags(), buildAliasMap(), resolveAliases()
  components.ts     # container(), TopLevelComponent, PUB_BUTTON_ID
  commands/
    ping.ts         # reference subcommand implementation
  test/
    e2e.ts          # test harness: commandJSON, autocompleteJSON, dispatch, getCallback, getEdit
    ping.test.ts    # reference test file
```

---

## AUTOCOMPLETE — ONE RULE

When detecting whether the user has moved past the subcommand name into the args position:

```ts
// CORRECT
const inArgs = focused.includes(' ')

// WRONG — flags get stripped from bare, so "ping --flag" looks like bare="ping" (no space)
const inArgs = bare.includes(' ')
```
