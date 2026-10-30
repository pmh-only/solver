const form = document.querySelector('#editor')
const nameInput = document.querySelector('#name')
const promptInput = document.querySelector('#prompt')
const status = document.querySelector('#status')
const list = document.querySelector('#personas')

async function api(method = 'GET', body) {
  const response = await fetch('/api/personas', {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Persona-Editor': '1' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '요청에 실패했습니다.')
  return result.personas
}

function render(personas) {
  list.replaceChildren()
  if (!personas.length) list.textContent = '아직 페르소나가 없습니다. 첫 페르소나를 만들어 보세요.'
  for (const persona of personas) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = persona.name
    button.addEventListener('click', () => {
      nameInput.value = persona.name
      promptInput.value = persona.prompt
      status.textContent = '사용법: @role <|' + persona.name + '|> 안녕'
      promptInput.focus()
    })
    list.append(button)
  }
}

async function operation(work, success) {
  const buttons = [...document.querySelectorAll('button')]
  buttons.forEach((button) => { button.disabled = true })
  status.textContent = '처리 중…'
  try {
    render(await work())
    status.textContent = success
  } catch (error) {
    status.textContent = error.message
  } finally {
    buttons.forEach((button) => { button.disabled = false })
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const name = nameInput.value.trim()
  const prompt = promptInput.value.trim()
  if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(name) || !prompt) {
    status.textContent = '이름 형식과 성격·말투 내용을 확인해 주세요.'
    return
  }
  void operation(() => api('PUT', { name, prompt }), '저장했습니다. @role <|' + name + '|> 안녕')
})
document.querySelector('#delete').addEventListener('click', () => {
  const name = nameInput.value.trim()
  if (!name || !confirm('공용 페르소나 "' + name + '"을 삭제할까요?')) return
  void operation(async () => {
    const personas = await api('DELETE', { name })
    form.reset()
    return personas
  }, '삭제했습니다.')
})
document.querySelector('#new').addEventListener('click', () => { form.reset(); nameInput.focus() })
document.querySelector('#refresh').addEventListener('click', () => { void operation(() => api(), '목록을 새로 불러왔습니다.') })
void operation(() => api(), '최대 100개 · 페르소나당 최대 4000자 · 모두에게 공개됩니다.')
