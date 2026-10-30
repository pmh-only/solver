const form = document.querySelector('#search-form')
const query = document.querySelector('#query')
const submit = document.querySelector('#submit')
const status = document.querySelector('#status')
let csrfToken = null
let busy = false

function notify(message, error = false) {
  status.textContent = message
  status.dataset.error = String(error)
}
function controls() {
  query.disabled = !csrfToken || busy
  submit.disabled = !csrfToken || busy || !query.value.trim()
  submit.textContent = busy ? '검색 중…' : '메시지 검색 ↗'
  form.setAttribute('aria-busy', String(busy))
  document.querySelectorAll('[data-example]').forEach((button) => {
    button.disabled = !csrfToken || busy
  })
}
async function loadSession() {
  try {
    const response = await fetch('/api/archive-search/session', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) {
      document.querySelector('#login-panel').hidden =
        response.status !== 401 && response.status !== 403
      document.querySelector('#channel').textContent = '로그인 후 채널 확인'
      throw new Error(data.error || '로그인 정보를 확인할 수 없습니다.')
    }
    csrfToken = data.csrfToken
    document.querySelector('#identity').textContent = data.user.name
    document.querySelector('#channel').textContent = '# ' + data.channel.name
    document.querySelector('#login-panel').hidden = true
    notify('찾고 싶은 메시지를 입력해 주세요.')
  } catch (error) {
    notify(error.message, true)
  }
  controls()
}
function render(data) {
  const results = document.querySelector('#results')
  results.replaceChildren()
  document.querySelector('#results-panel').hidden = false
  document.querySelector('#result-meta').textContent =
    '“' +
    data.intent.keyword +
    '” · ' +
    (data.intent.scope === 'all'
      ? '본문·임베드'
      : data.intent.scope === 'content'
        ? '본문'
        : '임베드')
  for (const item of data.matches.slice(0, 5)) {
    const article = document.createElement('article')
    article.className = 'result'
    const header = document.createElement('div')
    header.className = 'result-header'
    const author = document.createElement('strong')
    author.textContent = item.authorName
    const field = document.createElement('span')
    field.textContent = item.field === 'content' ? '본문' : '임베드'
    header.append(author, field)
    const snippet = document.createElement('p')
    snippet.textContent = item.snippet
    const link = document.createElement('a')
    // Do not trust arbitrary URLs even if an API response is compromised.
    if (/^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}\/\d{17,20}$/.test(item.url)) {
      link.href = item.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = 'Discord에서 원문 보기 ↗'
    }
    article.append(header, snippet, link)
    results.append(article)
  }
  const notes = []
  if (data.more) notes.push('추가 결과가 있습니다. 검색어를 더 구체적으로 입력해 보세요.')
  if (!data.historyComplete)
    notes.push('과거 기록 수집이 아직 완료되지 않아 일부 결과가 빠질 수 있습니다.')
  if (data.pendingEvents) notes.push('실시간 반영을 기다리는 메시지가 있습니다.')
  document.querySelector('#result-note').textContent = notes.join(' ')
  notify(
    data.matches.length
      ? data.matches.length + '개의 원문을 확인했습니다.'
      : '현재 원문에서 확인 가능한 검색 결과가 없습니다.'
  )
}
query.addEventListener('input', controls)
document.querySelectorAll('[data-example]').forEach((button) => {
  button.addEventListener('click', () => {
    query.value = button.dataset.example
    query.focus()
    controls()
  })
})
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!csrfToken || busy || !query.value.trim()) return
  busy = true
  controls()
  document.querySelector('#results-panel').hidden = true
  notify('AI가 요청을 이해하고 Discord 원문을 확인하고 있습니다…')
  try {
    const response = await fetch('/api/archive-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ prompt: query.value.trim() }),
      signal: AbortSignal.timeout(30000)
    })
    const data = await response.json()
    if (!response.ok) {
      if (response.status === 401) {
        csrfToken = null
        document.querySelector('#login-panel').hidden = false
      }
      throw new Error(data.error || '검색에 실패했습니다.')
    }
    render(data)
  } catch (error) {
    notify(
      error.name === 'TimeoutError'
        ? '검색 시간이 초과되었습니다. 다시 시도해 주세요.'
        : error.message,
      true
    )
  } finally {
    busy = false
    controls()
  }
})
void loadSession()
