import { SlashCommandBuilder } from 'discord.js'
import { AGENT_COMMAND_NAME, AGENT_EFFORT_OPTIONS } from './config.js'

export const agentCommand = new SlashCommandBuilder()
  .setName(AGENT_COMMAND_NAME)
  .setDescription('ask an AI agent')
  .addStringOption((option) =>
    option
      .setName('prompt')
      .setDescription('what to ask, or /clear to reset session')
      .setRequired(true)
  )
  .addAttachmentOption((option) =>
    option.setName('attachment').setDescription('photo or document to include with the prompt')
  )
  .addStringOption((option) =>
    option
      .setName('session')
      .setDescription('conversation session')
      .setMaxLength(100)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option.setName('model').setDescription('model for this session').setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName('effort')
      .setDescription('reasoning effort for this session')
      .addChoices(...AGENT_EFFORT_OPTIONS.map(({ id, label }) => ({ name: label, value: id })))
  )
  .addIntegerOption((option) =>
    option
      .setName('tokens')
      .setDescription('maximum output tokens for this session')
      .setMinValue(256)
      .setMaxValue(16384)
  )
  .addBooleanOption((option) =>
    option.setName('tools').setDescription('enable agent and web search tools for this session')
  )
  .addStringOption((option) =>
    option.setName('system_prompt').setDescription('persistent instructions for this session')
  )
  .addBooleanOption((option) =>
    option
      .setName('reset_system_prompt')
      .setDescription('remove this session system prompt before running')
  )
  .addStringOption((option) =>
    option.setName('openai_endpoint').setDescription('persistent OpenAI-compatible base URL')
  )
  .addBooleanOption((option) =>
    option.setName('reset_openai_endpoint').setDescription('restore the official OpenAI endpoint')
  )
  .addBooleanOption((option) =>
    option.setName('debug').setDescription('show detailed request and response timing')
  )
