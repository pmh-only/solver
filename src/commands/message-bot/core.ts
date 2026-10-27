// Command bodies ported from pmh-only/bot (MIT, Copyright (c) 2026 Minhyeok Park).
// Only imports, I/O dependencies, and TypeScript types are adapted here.
// See docs/community-integration.md for the upstream license.

export interface SetRecord {
  content: string
  authorId: string
}

export interface BotMessage {
  content: string
  author: { id: string }
  reply(options: { content: string; allowedMentions: { parse: never[] } }): void
}

type CommandRunner = (client: unknown, message: BotMessage) => void | Promise<void>

export function createOriginalBotCommands({
  PREFIX,
  setData,
  saveSetData,
  foodData,
  fetch
}: {
  PREFIX: string
  setData: Record<string, SetRecord>
  saveSetData: () => void
  foodData: Array<{ name: string; tags: string[] }>
  fetch: (url: string) => Promise<{ json(): Promise<unknown> }>
}) {
  const escapeRegex = (str: string) => str.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')
  const reservedSetKeys = ['help', 'list']

  const pingFn: CommandRunner = (_client, message) => {
    if (message.content !== PREFIX + 'ping') return
    message.reply({ content: 'pong!', allowedMentions: { parse: [] } })
  }

  const nowFn: CommandRunner = (_client, message) => {
    if (message.content !== PREFIX + 'now') return
    const date = new Date()
    message.reply({
      content: `${date} (${date.getTime()}) <t:${Math.floor(date.getTime() / 1000)}:R>`,
      allowedMentions: { parse: [] }
    })
  }

  const setFn: CommandRunner = (_client, message) => {
    const [prefix, key, ...values] = message.content.split(' ')
    const value = values.join(' ')
    if (prefix !== PREFIX + 'set') return
    if (key === undefined || key.length < 1) {
      message.reply({ content: PREFIX + 'set <match> [...reply]', allowedMentions: { parse: [] } })
      return
    }
    if (reservedSetKeys.includes(key)) {
      delete setData[key]
      saveSetData()
      message.reply({ content: key + ' deleted', allowedMentions: { parse: [] } })
      return
    }
    if (value.length < 1) {
      delete setData[key]
      message.reply({ content: key + ' deleted', allowedMentions: { parse: [] } })
    } else {
      setData[key] = { content: value, authorId: message.author.id }
      message.reply({ content: key + ' added', allowedMentions: { parse: [] } })
    }
    saveSetData()
  }

  const convFn: CommandRunner = async (_client, message) => {
    const args = message.content.split(' ')
    if (!args[0]?.startsWith(PREFIX)) return
    let amount = 0,
      source = '',
      target = ''
    // !1 usd to krw
    if (args[2] === 'to') {
      amount = parseFloat(args[0].replace(PREFIX, ''))
      if (Number.isNaN(amount) || args.length < 4) return
      source = args[1] ?? ''
      target = args[3] ?? ''
    }
    // !1usd to krw
    if (args[1] === 'to') {
      const groups = new RegExp(`${escapeRegex(PREFIX)}(\\d+)(\\w+)`).exec(args[0])
      if (groups === null || groups.length !== 3 || args.length < 3) return
      amount = parseFloat(groups[1] ?? '')
      source = groups[2] ?? ''
      target = args[2] ?? ''
    }
    const currencies = (await fetch(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/' +
        source +
        '.json'
    )
      .then((res) => res.json())
      .catch(() => false)) as Record<string, Record<string, number> | undefined>
    const result = amount * (currencies?.[source]?.[target] as number)
    if (result) {
      message.reply({ content: `${result} ${target}`, allowedMentions: { parse: [] } })
    }
  }

  const pizzaFn: CommandRunner = async (_client, message) => {
    if (message.content !== PREFIX + 'pizza') return
    const pizza = (await fetch('https://www.pizzint.watch/api/dashboard-data?nocache=1').then(
      (res) => res.json()
    )) as { defcon_level: unknown }
    message.reply({
      content: `:pizza: PIZZA INDEX\n> **DEFCON ${pizza.defcon_level}**\n-# <https://www.pizzint.watch>`,
      allowedMentions: { parse: [] }
    })
  }

  const foodFn: CommandRunner = (_client, message) => {
    if (message.content !== '점메추' && message.content !== '저메추') return
    const randomFood = foodData[Math.floor(Math.random() * foodData.length)]
    message.reply({
      content: `${randomFood.name} ${randomFood.tags.map((v: string) => `#${v}`).join(' ')}`,
      allowedMentions: { parse: [] }
    })
  }

  const listFn: CommandRunner = (_client, message) => {
    if (message.content !== PREFIX + 'list') return
    const keys = Object.keys(setData).sort()
    message.reply({
      content: keys.length > 0 ? keys.map((key) => PREFIX + key).join('\n') : 'no set commands',
      allowedMentions: { parse: [] }
    })
  }

  const helpFn: CommandRunner = (_client, message) => {
    if (message.content !== PREFIX + 'help') return
    message.reply({
      content: [
        PREFIX + 'help - show commands',
        PREFIX + 'ping - pong',
        PREFIX + 'now - current time',
        PREFIX + 'set <match> [...reply] - add or delete a set command',
        PREFIX + 'list - list set command keys',
        PREFIX + 'pizza - show pizza index',
        PREFIX + '<amount> <currency> to <currency> - convert currencies',
        '점메추 / 저메추 - random food'
      ].join('\n'),
      allowedMentions: { parse: [] }
    })
  }

  return {
    fns: [pingFn, nowFn, setFn, convFn, pizzaFn, foodFn, listFn, helpFn],
    replyToSavedCommand(message: BotMessage) {
      const setValue = setData[message.content.replace(PREFIX, '')]
      if (
        !reservedSetKeys.includes(message.content.replace(PREFIX, '')) &&
        message.content.startsWith(PREFIX) &&
        setValue !== undefined
      ) {
        message.reply({
          content: setValue.content + '\n-# <@' + setValue.authorId + '>',
          allowedMentions: { parse: [] }
        })
      }
    }
  }
}
