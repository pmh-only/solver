import {
  ComponentType,
  MessageFlags,
  type MediaGalleryComponentData,
  type UserContextMenuCommandInteraction
} from 'discord.js'
import { publishButtonRow, scheduleEphemeralReplyDelete, separator, text } from '../components.js'

export const USER_IMAGES_COMMAND_NAME = 'User Images'

interface ImageVariant {
  label: string
  url: string | null
}

function imageVariants(interaction: UserContextMenuCommandInteraction) {
  const user = interaction.targetUser
  const userAvatar = user.avatarURL({ size: 4096 }) ?? user.defaultAvatarURL
  const userBanner = user.bannerURL({ size: 4096 }) ?? null

  return [
    { label: 'User avatar', url: userAvatar },
    { label: 'User banner', url: userBanner }
  ] satisfies ImageVariant[]
}

function buildGallery(variants: ImageVariant[]): MediaGalleryComponentData | null {
  const items = variants
    .filter((variant): variant is ImageVariant & { url: string } => Boolean(variant.url))
    .map((variant) => ({
      media: { url: variant.url },
      description: variant.label
    }))

  if (items.length === 0) return null

  return {
    type: ComponentType.MediaGallery,
    items
  }
}

function linksBlock(variants: ImageVariant[]) {
  return text(
    [
      '**Image links**',
      ...variants.map((variant) =>
        variant.url
          ? `- **${variant.label}:** [open image](${variant.url})`
          : `- **${variant.label}:** Unavailable.`
      )
    ].join('\n')
  )
}

export async function handleUserImagesCommand(interaction: UserContextMenuCommandInteraction) {
  const user = await interaction.targetUser.fetch(true)
  const variants = imageVariants(interaction)
  const gallery = buildGallery(variants)

  await interaction.reply({
    components: [
      text(`## Images for ${user.displayName}\n-# ${user.tag} (${user.id})`),
      separator(),
      ...(gallery ? [gallery] : []),
      linksBlock(variants),
      publishButtonRow()
    ],
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
  })
  const message = (await interaction.fetchReply()) as { id?: string }
  if (typeof message.id === 'string') {
    scheduleEphemeralReplyDelete(interaction, message.id, [
      MessageFlags.IsComponentsV2,
      MessageFlags.Ephemeral
    ])
  }
}
