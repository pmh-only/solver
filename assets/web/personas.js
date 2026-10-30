const form = document.querySelector('#editor')
const nameInput = document.querySelector('#name')
const promptInput = document.querySelector('#prompt')
const status = document.querySelector('#status')
const list = document.querySelector('#personas')
const search = document.querySelector('#search')
const save = document.querySelector('#save')
const remove = document.querySelector('#delete')
const duplicate = document.querySelector('#duplicate')
const usage = document.querySelector('#usage')
let personas = []
let selected = null
let baseline = { name: '', prompt: '' }
let busy = false
let csrfToken = null

function draft() {
  return { name: nameInput.value.trim(), prompt: promptInput.value.trim() }
}
function dirty() {
  return nameInput.value !== baseline.name || promptInput.value !== baseline.prompt
}
function notify(message, tone = '') {
  status.textContent = message
  status.dataset.tone = tone
}

async function api(method = 'GET', body) {
  const response = await fetch('/api/personas', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Persona-Editor': '1',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const result = await response.json()
  if (result.csrfToken) csrfToken = result.csrfToken
  if (response.status === 401 || response.status === 403) {
    document.querySelector('#persona-login').hidden = false
    if (response.status === 401) {
      csrfToken = null
      personas = []
      render()
    }
  }
  if (!response.ok)
    throw new Error(result.error || '요청에 실패했습니다. 잠시 후 다시 시도해 주세요.')
  return result.personas
}

function sync() {
  const changed = dirty()
  const value = draft()
  document.querySelector('#character-count').textContent = promptInput.value.length + ' / 4000'
  usage.textContent = '@role <|' + (value.name || 'persona_name') + '|> 안녕'
  nameInput.readOnly = selected !== null
  document.querySelector('#name-help').textContent = selected
    ? '등록된 이름은 변경할 수 없습니다. 다른 이름으로 등록하려면 복제를 사용하십시오.'
    : '1–40자 · 문자, 숫자, _ 또는 - · 대소문자 구분'
  document.querySelector('#editor-mode').textContent = selected ? '상세 편집' : '신규 등록'
  document.querySelector('#editor-heading').textContent = selected || '페르소나 지침'
  const saveState = document.querySelector('#save-state')
  saveState.textContent = changed ? '미저장 변경사항' : selected ? '저장됨' : '변경 없음'
  saveState.dataset.dirty = String(changed)
  save.textContent = busy ? '처리 중…' : selected ? '수정사항 저장' : '등록'
  save.disabled =
    !csrfToken || busy || !changed || !/^[\p{L}\p{N}_-]{1,40}$/u.test(value.name) || !value.prompt
  remove.disabled = busy || !selected
  duplicate.disabled = busy || !selected
  document.querySelector('#editor-fields').disabled = busy || !csrfToken
  document.querySelector('#new').disabled = busy || !csrfToken
  document.querySelector('#refresh').disabled = busy
  document.querySelector('#copy-usage').disabled = busy || !value.name
  list.querySelectorAll('button').forEach((button) => {
    button.disabled = busy
  })
}

function render() {
  list.replaceChildren()
  document.querySelector('#persona-count').textContent = String(personas.length)
  const query = search.value.trim().toLocaleLowerCase()
  const filtered = personas.filter((persona) =>
    (persona.name + ' ' + persona.prompt).toLocaleLowerCase().includes(query)
  )
  if (!filtered.length) {
    const row = document.createElement('tr')
    const empty = document.createElement('td')
    empty.setAttribute('colspan', '3')
    empty.className = 'empty-state'
    empty.textContent = query
      ? '검색 조건에 해당하는 페르소나가 없습니다.'
      : '등록된 페르소나가 없습니다. 신규 등록을 선택하십시오.'
    row.append(empty)
    list.append(row)
  }
  for (const persona of filtered) {
    const row = document.createElement('tr')
    row.dataset.selected = String(persona.name === selected)
    const nameCell = document.createElement('td')
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'persona-select'
    name.setAttribute('aria-pressed', String(persona.name === selected))
    name.textContent = persona.name
    const excerpt = document.createElement('td')
    excerpt.className = 'persona-excerpt'
    excerpt.textContent = persona.prompt.replace(/\s+/g, ' ').slice(0, 90)
    nameCell.append(name)
    const length = document.createElement('td')
    length.className = 'numeric'
    length.textContent = String(persona.prompt.length)
    row.append(nameCell, excerpt, length)
    row.addEventListener('click', () => {
      if (busy || persona.name === selected || !mayDiscard()) return
      open(persona)
      notify('선택한 페르소나를 편집합니다. 저장 시 공용 목록에 반영됩니다.')
    })
    list.append(row)
  }
  sync()
}

function mayDiscard() {
  return !dirty() || confirm('미저장 변경사항을 삭제하고 이동하시겠습니까?')
}
function open(persona = null) {
  selected = persona?.name ?? null
  baseline = { name: persona?.name ?? '', prompt: persona?.prompt ?? '' }
  nameInput.value = baseline.name
  promptInput.value = baseline.prompt
  render()
}

async function operation(work) {
  if (busy) return
  busy = true
  sync()
  try {
    await work()
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    busy = false
    sync()
  }
}

form.addEventListener('input', sync)
search.addEventListener('input', render)
form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (save.disabled) return
  const value = draft()
  if (!selected && personas.some((persona) => persona.name === value.name)) {
    notify('이미 사용 중인 이름입니다. 다른 이름을 입력하거나 기존 항목을 선택하십시오.', 'error')
    nameInput.focus()
    return
  }
  void operation(async () => {
    const latest = await api()
    const existing = latest.find((persona) => persona.name === value.name)
    if (
      (!selected && existing) ||
      (selected && (!existing || existing.prompt !== baseline.prompt))
    ) {
      if (
        !confirm(
          '다른 사용자가 이 항목을 수정하거나 삭제했습니다. 현재 편집 내용으로 덮어쓰시겠습니까?'
        )
      )
        return
    }
    personas = await api('PUT', value)
    open(value)
    notify('저장되었습니다. 호출 명령을 복사하여 Discord에서 사용할 수 있습니다.', 'success')
  })
})
remove.addEventListener('click', () => {
  if (
    !selected ||
    !confirm('‘' + selected + '’을 삭제하시겠습니까? 모든 사용자의 공용 목록에서 제거됩니다.')
  )
    return
  const name = selected
  void operation(async () => {
    personas = await api('DELETE', { name })
    open()
    notify('페르소나가 삭제되었습니다.', 'success')
  })
})
document.querySelector('#new').addEventListener('click', () => {
  if (!mayDiscard()) return
  open()
  notify('신규 페르소나의 이름과 응답 지침을 입력하십시오.')
  nameInput.focus()
})
duplicate.addEventListener('click', () => {
  const value = draft()
  const base = value.name.slice(0, 32) + '_복사'
  let name = base
  for (let suffix = 2; personas.some((persona) => persona.name === name); suffix++)
    name = base + suffix
  selected = null
  baseline = { name: '', prompt: '' }
  nameInput.value = name
  promptInput.value = value.prompt
  render()
  notify('복사본을 작성합니다. 저장 전까지 원본에는 영향이 없습니다.')
  nameInput.focus()
})
document.querySelector('#refresh').addEventListener('click', () => {
  void operation(async () => {
    personas = await api()
    if (!dirty() && selected) open(personas.find((persona) => persona.name === selected) ?? null)
    else render()
    notify('목록을 갱신했습니다. 미저장 편집 내용은 유지됩니다.')
  })
})
document.querySelector('#copy-usage').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(usage.textContent)
    notify('호출 명령이 복사되었습니다.', 'success')
  } catch {
    notify('클립보드에 접근할 수 없습니다. 호출 명령을 직접 선택하여 복사하십시오.', 'error')
  }
})
window.addEventListener('beforeunload', (event) => {
  if (!dirty()) return
  event.preventDefault()
  event.returnValue = ''
})
void operation(async () => {
  personas = await api()
  render()
  notify('목록에서 편집할 항목을 선택하거나 신규 페르소나를 등록하십시오.')
})
