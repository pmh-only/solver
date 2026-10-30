import {
  loadCommunitySettings,
  manageCommunitySettings,
  personaSchema
} from './community-settings.js'

export function listPersonas() {
  return loadCommunitySettings().personas
}

export function savePersona(input: unknown) {
  const persona = personaSchema.parse(input)
  const personas = listPersonas().filter((item) => item.name !== persona.name)
  personas.push(persona)
  return manageCommunitySettings({ action: 'update', settings: { personas } }).personas
}

export function deletePersona(input: unknown) {
  const { name } = personaSchema.pick({ name: true }).parse(input)
  const personas = listPersonas().filter((item) => item.name !== name)
  return manageCommunitySettings({ action: 'update', settings: { personas } }).personas
}
