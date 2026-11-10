import { escapeMarkdown, PermissionFlagsBits } from 'discord.js'
import type { Subcommand } from '../types.js'
import { commandContainer, sendCommandReply, summarySection, text } from '../components.js'
import { loadCommunitySettings } from '../community-settings.js'
import { deletedMessageHistory } from '../deleted-messages.js'

export const subcommand: Subcommand = {
  name: 'deleted',
  description: '현재 채널에서 최근 삭제된 메시지를 함께 확인합니다',
  usage: '/deleted',
  examples: ['/deleted'],
  async execute(interaction, _args, flags) {
    if (!interaction.guildId || !interaction.isChatInputCommand())
      throw new Error('서버에서만 사용할 수 있습니다.')
    const settings = loadCommunitySettings()
    if (!settings.deletedMessages.enabled || settings.disabledCommands.includes('deleted')) {
      deletedMessageHistory.clear()
      throw new Error('비활성화된 기능입니다.')
    }
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
    if (!interaction.memberPermissions?.has(required) || !interaction.appPermissions?.has(required))
      throw new Error('사용자와 봇 모두 채널 보기 및 메시지 기록 보기 권한이 필요합니다.')
    const records = deletedMessageHistory.recent(interaction.guildId, interaction.channelId)
    await sendCommandReply(
      interaction,
      commandContainer(
        subcommand,
        'deleted',
        flags,
        summarySection('최근 삭제된 메시지', [
          `-# 현재 채널 · 최근 ${settings.deletedMessages.retentionMinutes}분 · 최대 5개`,
          '-# 봇이 내용을 확인한 메시지만 표시됩니다. 재시작하면 기록이 사라집니다.'
        ]),
        ...(records.length
          ? records.map((record) =>
              text(
                [
                  `<@${record.authorId}> · 삭제 <t:${Math.floor(record.deletedAt / 1000)}:R>`,
                  escapeMarkdown(record.content).slice(0, 450) || '(텍스트 없음)',
                  ...(record.attachments.length
                    ? [`첨부: ${escapeMarkdown(record.attachments.join(', ')).slice(0, 120)}`]
                    : [])
                ].join('\n')
              )
            )
          : [text('최근 삭제된 메시지가 없습니다.')])
      )
    )
  }
}
