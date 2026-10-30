import {
  loadCommunitySettings,
  manageCommunitySettings,
  personaSchema
} from './community-settings.js'
import { personaContainsRelationshipPolicy } from './relationship-policy.js'

export function listPersonas() {
  return loadCommunitySettings().personas
}

export function savePersona(input: unknown) {
  const persona = personaSchema.parse(input)
  if (personaContainsRelationshipPolicy(`${persona.name}\n${persona.prompt}`)) {
    throw new Error('페르소나에는 호감도·혐오도 관련 내용을 넣을 수 없습니다.')
  }
  const personas = listPersonas().filter((item) => item.name !== persona.name)
  personas.push(persona)
  return manageCommunitySettings({ action: 'update', settings: { personas } }).personas
}

export function deletePersona(input: unknown) {
  const { name } = personaSchema.pick({ name: true }).parse(input)
  const personas = listPersonas().filter((item) => item.name !== name)
  return manageCommunitySettings({ action: 'update', settings: { personas } }).personas
}
