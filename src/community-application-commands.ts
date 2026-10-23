import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
  type SlashCommandBooleanOption
} from 'discord.js'

function guildCommand(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(null)
}
const publicOption = (option: SlashCommandBooleanOption) =>
  option.setName('public').setDescription('응답을 채널에 공개합니다 (기본값: 비공개)')

const foodCommands = ['food', 'foods', '점메추', '저메추'].map((name) =>
  guildCommand(name, '음식을 추천합니다')
    .addStringOption((option) =>
      option.setName('filter').setDescription('음식 이름 또는 태그').setMaxLength(100)
    )
    .addBooleanOption(publicOption)
)

export const communityApplicationCommands = [
  ...foodCommands,
  guildCommand('pizza', '펜타곤 피자 지수 (비공식)').addBooleanOption(publicOption),
  guildCommand('now', '현재 시각을 확인합니다').addBooleanOption(publicOption),
  guildCommand('date', '서버 가입일을 확인합니다')
    .addUserOption((option) =>
      option.setName('member').setDescription('조회할 멤버 (기본값: 본인)')
    )
    .addBooleanOption(publicOption),
  guildCommand('color', '본인의 역할 색상을 변경합니다')
    .addStringOption((option) =>
      option.setName('hex').setDescription('#rgb 또는 #rrggbb').setRequired(true).setMaxLength(7)
    )
    .addStringOption((option) =>
      option.setName('secondary').setDescription('보조 색상 (#rgb 또는 #rrggbb)').setMaxLength(7)
    )
    .addBooleanOption(publicOption),
  guildCommand('invite', '일회용 초대 링크를 비공개로 생성합니다'),
  guildCommand('anon', '현재 채널에 익명 메시지를 보냅니다').addStringOption((option) =>
    option
      .setName('message')
      .setDescription('전송할 메시지')
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(2000)
  ),
  guildCommand('emoji', '첨부 이미지를 128px 이모지로 등록합니다')
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('영문, 숫자, 밑줄 2~32자')
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(32)
    )
    .addAttachmentOption((option) =>
      option.setName('image').setDescription('PNG, JPEG, BMP 이미지 (1 MiB 이하)').setRequired(true)
    )
    .addBooleanOption(publicOption),
  guildCommand('kickvote', '공개 추방 투표를 시작합니다')
    .addUserOption((option) => option.setName('user').setDescription('추방 대상').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('공개할 추방 사유')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(500)
    ),
  guildCommand('help', '커뮤니티 명령의 사용법을 확인합니다')
    .addStringOption((option) =>
      option.setName('command').setDescription('확인할 명령').setAutocomplete(true)
    )
    .addBooleanOption(publicOption)
].map((command) => ({ ...command.toJSON() }))
