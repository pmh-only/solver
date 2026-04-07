import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder
} from 'discord.js'
import type { Flags } from './flags.js'

export const PUB_BUTTON_ID = 'pub'

const pubButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(PUB_BUTTON_ID).setLabel('pub').setStyle(ButtonStyle.Secondary)
)

export type TopLevelComponent =
  | string
  | TextDisplayBuilder
  | ContainerBuilder
  | SeparatorBuilder
  | SectionBuilder
  | MediaGalleryBuilder
  | ActionRowBuilder<ButtonBuilder>

function resolve(c: TopLevelComponent) {
  return typeof c === 'string' ? new TextDisplayBuilder().setContent(c) : c
}

export function container(args: string, flags: Flags, ...components: TopLevelComponent[]) {
  const pub = flags.has('pub')
  const flagsStr = [...flags.entries()]
    .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`))
    .join(' ')
  const footer = `-# \`${[args, flagsStr].filter(Boolean).join(' ')}\``
  const resolved = components.map(resolve)
  const last = resolved.at(-1)
  if (last instanceof TextDisplayBuilder) {
    last.setContent(`${last.data.content}\n${footer}`)
  } else {
    resolved.push(new TextDisplayBuilder().setContent(footer))
  }
  return {
    components: pub ? resolved : [...resolved, pubButton],
    flags: pub
      ? ([MessageFlags.IsComponentsV2] as const)
      : ([MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] as const)
  }
}
