const queryElement = (selector) => document.querySelector(selector)
let state = {
  session: null,
  sessionName: 'default',
  promptSessionName: 'default',
  renderedSession: null,
  historySignatures: new Map(),
  debugTimings: new Map(),
  settingsSignature: '',
  runs: new Map(),
  starting: new Set(),
  loadVersion: 0,
  pollTimer: 0,
  pending: new Set(),
  modalTarget: null,
  following: true,
  unseen: false,
  scrollFrame: 0,
  scrollTimer: 0,
  autoScrolling: false
}

function embed(e) {
  let color = Number.isInteger(e.color) ? '#' + e.color.toString(16).padStart(6, '0') : '#5865f2'
  return (
    '<div class="embed" style="border-color:' +
    color +
    '">' +
    (e.author?.name ? '<small>' + esc(e.author.name) + '</small>' : '') +
    (e.title ? '<h3>' + esc(e.title) + '</h3>' : '') +
    (e.description ? '<div>' + md(e.description) + '</div>' : '') +
    (Array.isArray(e.fields)
      ? e.fields
          .map((f) => '<p><strong>' + esc(f.name) + '</strong><br>' + md(f.value) + '</p>')
          .join('')
      : '') +
    (e.footer?.text ? '<footer>' + esc(e.footer.text) + '</footer>' : '') +
    '</div>'
  )
}
function componentEmoji(e) {
  if (!e || typeof e !== 'object') return ''
  let name = esc(e.name || '')
  if (e.id && /^\d+$/.test(String(e.id)))
    return (
      '<img class="component-emoji" src="https://cdn.discordapp.com/emojis/' +
      esc(e.id) +
      '.webp?size=40" alt="' +
      name +
      '">'
    )
  return name ? '<span aria-hidden="true">' + name + '</span>' : ''
}
const attr = (name, value) =>
  value === undefined || value === null ? '' : ' ' + name + '="' + esc(value) + '"'
const emoji = (c) => (c?.emoji ? componentEmoji(c.emoji) + ' ' : '')
const liveId = (id) => /^gpt-action:[^:]+:[a-z0-9_-]{1,32}$/.test(id || '')
function buttonComponent(c) {
  let label = emoji(c) + esc(c.label || (!c.emoji ? 'Action' : '')),
    style = ['', 'primary', 'secondary', 'success', 'danger', 'link'][c.style] || 'secondary',
    disabled = c.disabled === true
  if (c.url) {
    if (disabled)
      return (
        '<span class="component-button ' + style + '" aria-disabled="true">' + label + '</span>'
      )
    return (
      '<a class="component-button ' +
      style +
      '" href="' +
      esc(c.url) +
      '" target="_blank" rel="noopener noreferrer">' +
      label +
      '</a>'
    )
  }
  if (!c.custom_id) return fallback(c)
  let live = liveId(c.custom_id)
  return (
    '<button type="button" class="component-button ' +
    style +
    '" data-component-id="' +
    esc(c.custom_id) +
    '"' +
    (disabled || !live ? ' disabled' : '') +
    (!live ? ' title="This historical interaction is unavailable"' : '') +
    '>' +
    label +
    '</button>'
  )
}
function stringSelect(c, modal = false) {
  let min = Number.isInteger(c.min_values) ? c.min_values : 1,
    max = Number.isInteger(c.max_values) ? c.max_values : 1,
    multiple = max > 1 ? ' multiple size="' + Math.min(max, 5) + '"' : ''
  let placeholder = c.placeholder || 'Make a selection',
    hasDefault = Array.isArray(c.options) && c.options.some((o) => o.default)
  let options =
    (!hasDefault && max === 1
      ? '<option value="" selected' +
        (min > 0 ? ' disabled' : '') +
        '>' +
        esc(placeholder) +
        '</option>'
      : '') +
    (Array.isArray(c.options)
      ? c.options
          .map(
            (o) =>
              '<option value="' +
              esc(o.value) +
              '"' +
              (o.default ? ' selected' : '') +
              '>' +
              emoji(o) +
              esc(o.label) +
              (o.description ? ' — ' + esc(o.description) : '') +
              '</option>'
          )
          .join('')
      : '')
  let id = esc(c.custom_id || ''),
    disabled = c.disabled || (!modal && !liveId(c.custom_id)),
    select =
      '<select class="component-select" data-field-type="3" data-min="' +
      min +
      '" data-max="' +
      max +
      '"' +
      (modal ? ' data-modal-field="' + id + '"' : ' data-select-id="' + id + '"') +
      multiple +
      (disabled ? ' disabled' : '') +
      ' aria-label="' +
      esc(placeholder) +
      '">' +
      options +
      '</select>'
  return modal
    ? select
    : '<div class="entity-select">' +
        select +
        '<button type="button" class="component-button secondary select-apply" data-component-id="' +
        id +
        '"' +
        (disabled ? ' disabled' : '') +
        '>Select</button></div>'
}
const entityNames = { 5: 'User', 6: 'Role', 7: 'Mentionable', 8: 'Channel' }
function entitySelect(c, modal = false) {
  let min = Number.isInteger(c.min_values) ? c.min_values : 1,
    max = Number.isInteger(c.max_values) ? c.max_values : 1,
    defaults = Array.isArray(c.default_values)
      ? c.default_values
          .map((v) => v.id)
          .filter(Boolean)
          .join(', ')
      : ''
  let id = esc(c.custom_id || ''),
    disabled = c.disabled || (!modal && !liveId(c.custom_id))
  return (
    '<div class="entity-select"><input type="text" value="' +
    esc(defaults) +
    '" placeholder="' +
    esc(c.placeholder || entityNames[c.type] + ' IDs, comma separated') +
    '" data-field-type="' +
    c.type +
    '" data-min="' +
    min +
    '" data-max="' +
    max +
    '"' +
    (modal ? ' data-modal-field="' + id + '"' : ' data-entity-id="' + id + '"') +
    (disabled ? ' disabled' : '') +
    '><button type="button" class="component-button secondary entity-apply" data-component-id="' +
    id +
    '"' +
    (modal || disabled ? ' disabled' : '') +
    '>Select</button></div>'
  )
}
function fallback(c) {
  return (
    '<div class="component-fallback" role="note">Unsupported Discord component' +
    (Number.isInteger(c?.type) ? ' (type ' + c.type + ')' : '') +
    '</div>'
  )
}
const componentRenderers = {
  1: (c) => '<div class="component-row">' + components(c.components) + '</div>',
  2: buttonComponent,
  3: (c) => stringSelect(c),
  5: (c) => entitySelect(c),
  6: (c) => entitySelect(c),
  7: (c) => entitySelect(c),
  8: (c) => entitySelect(c),
  9: (c) =>
    '<section>' +
    components(c.components) +
    (c.accessory ? components([c.accessory]) : '') +
    '</section>',
  10: (c) => (typeof c.content === 'string' ? '<div>' + md(c.content) + '</div>' : fallback(c)),
  14: () => '<hr>',
  17: (c) => '<div class="component-container">' + components(c.components) + '</div>'
}
function components(items) {
  if (!Array.isArray(items)) return ''
  return items
    .map((c) => {
      if (!c || typeof c !== 'object') return ''
      return (componentRenderers[c.type] || fallback)(c)
    })
    .join('')
}
function payload(raw) {
  let p = raw
  if (typeof raw === 'string') {
    try {
      p = JSON.parse(raw)
    } catch {
      return md(raw)
    }
  }
  if (!p || typeof p !== 'object') return ''
  return (
    (typeof p.content === 'string' ? md(p.content) : '') +
    (Array.isArray(p.embeds) ? p.embeds.map(embed).join('') : '') +
    components(p.components)
  )
}
function message(role, content, time = new Date(), runId, status) {
  let el = document.createElement('article')
  el.className = 'message ' + role
  if (runId) el.dataset.runId = runId
  if (status) el.dataset.status = status
  el.innerHTML =
    '<span class="avatar">' +
    (role === 'user' ? 'Y' : 'S') +
    '</span><div><div class="meta"><strong>' +
    (role === 'user' ? 'You' : 'Solver') +
    '</strong><time>' +
    new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
    '</time></div><div class="body">' +
    (role === 'assistant' ? payload(content) : md(content)) +
    '</div></div>'
  queryElement('#messages').append(el)
  return el
}
const empty = () => '<div class="empty">No messages yet</div>'
const messages = queryElement('#messages'),
  bottomThreshold = 72
function nearBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= bottomThreshold
}
function renderJump() {
  queryElement('#jump-bottom').hidden = state.following || !state.unseen
}
function setFollowing(value) {
  state.following = value
  if (value) state.unseen = false
  renderJump()
}
function stopAutoScroll() {
  state.autoScrolling = false
  clearTimeout(state.scrollTimer)
}
function followBottom(behavior = 'smooth') {
  if (!state.following) return
  cancelAnimationFrame(state.scrollFrame)
  state.scrollFrame = requestAnimationFrame(() => {
    state.autoScrolling = true
    messages.scrollTo({ top: messages.scrollHeight, behavior })
    clearTimeout(state.scrollTimer)
    state.scrollTimer = setTimeout(() => {
      state.autoScrolling = false
      if (nearBottom()) setFollowing(true)
    }, 1000)
  })
}
function contentChanged() {
  if (state.following) followBottom()
  else {
    state.unseen = true
    renderJump()
  }
}
const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(contentChanged) : null
new MutationObserver(() => {
  messages.querySelectorAll('.body').forEach((body) => resizeObserver?.observe(body))
  contentChanged()
}).observe(messages, { childList: true, subtree: true, characterData: true })
async function api(path, opt = {}) {
  opt.headers = {
    ...(opt.body ? { 'Content-Type': 'application/json' } : {}),
    ...(state.session?.csrfToken ? { 'X-CSRF-Token': state.session.csrfToken } : {}),
    ...opt.headers
  }
  let r = await fetch(path, opt)
  if (!r.ok) {
    let m = 'Request failed'
    try {
      m = (await r.json()).error || m
    } catch {}
    throw new Error(m)
  }
  return r
}
async function readUpdates(r, onUpdate) {
  let reader = r.body.getReader(),
    decoder = new TextDecoder(),
    buffer = ''
  while (true) {
    let { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    let lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (let line of lines) {
      if (line) onUpdate(JSON.parse(line))
    }
    if (done) break
  }
}
async function interaction(target, customId, values = [], fields) {
  if (state.pending.has(customId)) return
  state.pending.add(customId)
  let controls = [...(target.querySelectorAll?.('button,select,input') || [])].filter(
      (x) => !x.disabled
    ),
    status = target.querySelector?.('.interaction-status')
  if (!status) {
    status = document.createElement('div')
    status.className = 'interaction-status status'
    target.append(status)
  }
  status.textContent = 'Working…'
  controls.forEach((x) => (x.disabled = true))
  try {
    let r = await api('/api/chat/interaction', {
        method: 'POST',
        body: JSON.stringify({ customId, values, ...(fields ? { fields } : {}) })
      }),
      reader = r.body.getReader(),
      decoder = new TextDecoder(),
      buffer = ''
    while (true) {
      let { done, value } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      let lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (let line of lines) {
        if (!line) continue
        let update = JSON.parse(line)
        if (update.error) throw new Error(update.error)
        if (update.modal) {
          openModal(update.modal, target)
          status.textContent = ''
          continue
        }
        if (update.payload) {
          target.innerHTML = payload(update.payload)
        }
      }
      if (done) break
    }
  } catch (err) {
    status = target.querySelector?.('.interaction-status') || status
    status.className = 'interaction-status status error'
    status.textContent = err.message
  } finally {
    state.pending.delete(customId)
    if (target.isConnected)
      controls.forEach((x) => {
        if (x.isConnected) x.disabled = false
      })
  }
}
function modalText(c, label) {
  let common =
    ' data-modal-field="' +
    esc(c.custom_id) +
    '" data-field-type="4"' +
    attr('minlength', c.min_length) +
    attr('maxlength', c.max_length) +
    (c.required === false ? '' : ' required') +
    attr('placeholder', c.placeholder)
  let input =
    c.style === 2
      ? '<textarea rows="4"' + common + '>' + esc(c.value || '') + '</textarea>'
      : '<input type="text" value="' + esc(c.value || '') + '"' + common + '>'
  return (
    '<label class="modal-field"><span>' +
    esc(label || c.label || 'Text') +
    '</span>' +
    input +
    '</label>'
  )
}
function modalChoices(c, label, type) {
  let options = Array.isArray(c.options) ? c.options : [],
    radio = type === 21,
    min = radio
      ? c.required === false
        ? 0
        : 1
      : Number.isInteger(c.min_values)
        ? c.min_values
        : c.required === false
          ? 0
          : 1,
    max = radio ? 1 : Number.isInteger(c.max_values) ? c.max_values : options.length
  return (
    '<fieldset class="modal-field" data-modal-field="' +
    esc(c.custom_id) +
    '" data-field-type="' +
    type +
    '" data-min="' +
    min +
    '" data-max="' +
    max +
    '"><legend>' +
    esc(label || c.label || 'Choose') +
    '</legend><div class="modal-options">' +
    options
      .map(
        (o) =>
          '<label class="modal-option"><input type="' +
          (radio ? 'radio' : 'checkbox') +
          '" name="field-' +
          esc(c.custom_id) +
          '" value="' +
          esc(o.value) +
          '"' +
          (o.default ? ' checked' : '') +
          '><span>' +
          esc(o.label) +
          (o.description ? '<small><br>' + esc(o.description) + '</small>' : '') +
          '</span></label>'
      )
      .join('') +
    '</div></fieldset>'
  )
}
function modalComponent(c, label, description) {
  if (!c || typeof c !== 'object') return ''
  if (c.type === 1) return (c.components || []).map((x) => modalComponent(x)).join('')
  if (c.type === 18)
    return (
      '<div>' +
      (description || c.description
        ? '<small>' + esc(description || c.description) + '</small>'
        : '') +
      modalComponent(c.component, c.label, c.description) +
      '</div>'
    )
  if (c.type === 10) return '<div>' + md(c.content || '') + '</div>'
  if (c.type === 4) return modalText(c, label)
  if (c.type === 3)
    return (
      '<label class="modal-field"><span>' +
      esc(label || c.label || 'Choose') +
      '</span>' +
      stringSelect(c, true) +
      '</label>'
    )
  if (entityNames[c.type])
    return (
      '<label class="modal-field"><span>' +
      esc(label || c.label || entityNames[c.type]) +
      '</span>' +
      entitySelect(c, true) +
      '</label>'
    )
  if (c.type === 21 || c.type === 22) return modalChoices(c, label, c.type)
  if (c.type === 23)
    return (
      '<label class="modal-option modal-field"><input type="checkbox" data-modal-field="' +
      esc(c.custom_id) +
      '" data-field-type="23"' +
      (c.default ? ' checked' : '') +
      (c.required ? ' required' : '') +
      '><span>' +
      esc(label || c.label || 'Confirm') +
      '</span></label>'
    )
  return fallback(c)
}
function openModal(modal, target) {
  let dialog = queryElement('#interaction-modal'),
    form = queryElement('#interaction-modal-form')
  state.modalTarget = target
  form.dataset.customId = modal.custom_id || ''
  queryElement('#interaction-modal-title').textContent = modal.title || 'Complete form'
  queryElement('#interaction-modal-fields').innerHTML = (modal.components || [])
    .map((c) => modalComponent(c))
    .join('')
  queryElement('.modal-error').textContent = ''
  dialog.showModal()
}
function fieldValues(field) {
  let type = Number(field.dataset.fieldType),
    custom_id =
      field.dataset.modalField ||
      field.dataset.componentId ||
      field.dataset.entityId ||
      field.dataset.selectId
  if (type === 4) return { custom_id, type, value: field.value }
  if (type === 21)
    return { custom_id, type, value: field.querySelector('input:checked')?.value || null }
  if (type === 23) return { custom_id, type, value: field.checked }
  if (type === 3)
    return {
      custom_id,
      type,
      values: [...field.selectedOptions].map((o) => o.value).filter(Boolean)
    }
  if (entityNames[type])
    return {
      custom_id,
      type,
      values: field.value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    }
  return {
    custom_id,
    type,
    values: [...field.querySelectorAll('input:checked')].map((x) => x.value)
  }
}
function validateField(field, data) {
  let min = Number(field.dataset.min || 0),
    max = Number(field.dataset.max || 25),
    count = data.values?.length
  if (Number(field.dataset.fieldType) === 21 && !data.value && min > 0) return 'Select one value.'
  if (count !== undefined && (count < min || count > max))
    return 'Select between ' + min + ' and ' + max + ' value' + (max === 1 ? '' : 's') + '.'
  return ''
}
function controlsDisabled(disabled) {
  ;['#model-select', '#effort', '#max-tokens', '#tools-enabled', '#debug-mode'].forEach(
    (id) => (queryElement(id).disabled = disabled)
  )
}
function renderRunControls() {
  let running = state.runs.has(state.sessionName) || state.starting.has(state.sessionName)
  queryElement('#cancel-run').hidden = !state.runs.has(state.sessionName)
  queryElement('#cancel-run').disabled = state.starting.has(state.sessionName)
  controlsDisabled(running)
}
function runMessage(runId) {
  return [...messages.querySelectorAll('.assistant[data-run-id]')].find(
    (el) => el.dataset.runId === runId
  )
}
function scheduleSessionPoll(version = state.loadVersion) {
  clearTimeout(state.pollTimer)
  state.pollTimer = setTimeout(
    () =>
      syncSession(version).catch(() => {
        if (version === state.loadVersion) scheduleSessionPoll(version)
      }),
    1000
  )
}
function renderSessionOptions(sessions) {
  let select = queryElement('#session-select')
  select.innerHTML =
    sessions
      .map((name) => '<option value="' + esc(name) + '">' + esc(name) + '</option>')
      .join('') + '<option value="">+ New session</option>'
  select.value = state.sessionName
}
function debugTimingKey(sessionName, assistantIndex) {
  return sessionName + '\n' + assistantIndex
}
function renderSessionState(data) {
  renderSessionOptions(data.sessions)
  state.settingsSignature = JSON.stringify(data.settings)
  queryElement('#model-select').value = data.settings.model
  queryElement('#effort').value = data.settings.effort
  queryElement('#max-tokens').value = data.settings.maxTokens
  queryElement('#max-tokens-value').value = data.settings.maxTokens
  queryElement('#tools-enabled').checked = data.settings.toolsEnabled
}
async function loadModels() {
  try {
    let r = await api('/models'),
      data = await r.json()
    queryElement('#model-options').innerHTML = (data.models || [])
      .map((model) => '<option value="' + esc(model) + '"></option>')
      .join('')
  } catch (e) {
    queryElement('#model-select').title = 'Could not load models: ' + e.message
  }
}
async function history(name = state.sessionName, version = state.loadVersion) {
  let r = await api('/api/chat/history?session=' + encodeURIComponent(name)),
    turns = await r.json()
  if (name !== state.sessionName || version !== state.loadVersion) return
  clearTimeout(state.pollTimer)
  let active = turns.find((t) => t.role === 'assistant' && t.status === 'running' && t.runId),
    existing = state.runs.get(name),
    local = active && existing?.id === active.runId && existing.local,
    signature = JSON.stringify(turns)
  if (active) state.runs.set(name, { id: active.runId, local: !!local })
  else state.runs.delete(name)
  if (state.renderedSession !== name || state.historySignatures.get(name) !== signature) {
    state.renderedSession = name
    state.historySignatures.set(name, signature)
    queryElement('#messages').innerHTML = turns.length ? '' : empty()
    let assistantIndex = 0
    turns.forEach((t) => {
      let target = message(t.role, t.content, t.startedAt || new Date(), t.runId, t.status)
      if (t.role !== 'assistant') return
      let timing = state.debugTimings.get(debugTimingKey(name, assistantIndex++))
      if (timing) renderTiming(target, timing.server, timing.browser)
    })
  }
  renderRunControls()
  if (!local) scheduleSessionPoll(version)
}
async function syncSession(version = state.loadVersion) {
  let r = await api('/api/chat/sessions'),
    data = await r.json()
  if (version !== state.loadVersion) return
  let name = data.selectedSession
  if (name !== state.sessionName) {
    state.sessionName = name
    version = ++state.loadVersion
    renderSessionState(data)
  } else if (state.settingsSignature !== JSON.stringify(data.settings)) renderSessionState(data)
  else renderSessionOptions(data.sessions)
  await history(name, version)
}
async function session() {
  let r = await fetch('/api/session')
  state.session = await r.json()
  let yes = !!state.session.user,
    setup = state.session.oidcSetupRequired
  queryElement('#auth-view').hidden = yes || setup
  queryElement('#chat-view').hidden = !yes
  queryElement('#settings-view').hidden = !setup
  queryElement('#prompt-settings-view').hidden = true
  queryElement('#admin-prompt').hidden = !yes
  queryElement('#login').hidden = !state.session.oidcEnabled
  queryElement('#setup-notice').hidden = !setup
  queryElement('#settings-eyebrow').textContent = setup ? 'INITIAL SETUP' : 'ADMINISTRATION'
  if (setup) {
    queryElement('#settings-form').elements.enabled.checked = true
    await settings()
    return
  }
  if (yes) {
    try {
      let sessions = await api('/api/chat/sessions'),
        data = await sessions.json()
      state.sessionName = data.selectedSession
      renderSessionState(data)
      await Promise.all([history(), loadModels()])
    } catch (e) {
      queryElement('#messages').innerHTML = '<div class="empty error">' + esc(e.message) + '</div>'
      queryElement('#composer').hidden = true
    }
  } else if (state.session.automaticLogin && state.session.oidcEnabled)
    location.href = '/auth/login'
}
async function settings() {
  try {
    let r = await api('/api/admin/oidc'),
      data = await r.json(),
      f = queryElement('#settings-form')
    Object.entries(data || {}).forEach(([k, v]) => {
      let field = f.elements.namedItem(k)
      if (!field) return
      if (field.type === 'checkbox') field.checked = !!v
      else if (k !== 'hasClientSecret') field.value = v ?? ''
    })
    queryElement('#secret-state').textContent = data?.hasClientSecret ? 'A secret is stored.' : ''
  } catch (e) {
    queryElement('#settings-status').textContent = e.message
  }
}
function renderPromptSetting(data) {
  queryElement('#prompt-settings-form').elements.prompt.value = data.prompt
  queryElement('#prompt-metadata').textContent = data.updatedAt
    ? 'Last updated ' + new Date(data.updatedAt).toLocaleString() + ' by ' + data.updatedBy
    : data.isDefault
      ? 'Using built-in default'
      : ''
}
function renderSessionPromptSetting(data) {
  queryElement('#session-prompt-settings-form').elements.prompt.value = data.prompt
  queryElement('#session-prompt-metadata').textContent = data.updatedAt
    ? 'Last updated ' + new Date(data.updatedAt).toLocaleString() + ' by ' + data.updatedBy
    : 'No session-specific prompt is set.'
}
function renderOpenAIEndpoint(data) {
  queryElement('#openai-endpoint-form').elements.endpoint.value = data.endpoint
  queryElement('#openai-endpoint-metadata').textContent = data.updatedAt
    ? 'Last updated ' + new Date(data.updatedAt).toLocaleString() + ' by ' + data.updatedBy
    : data.isDefault
      ? 'Using official OpenAI'
      : ''
}
function renderOpenAIToken(data) {
  queryElement('#openai-token-form').elements.token.value = ''
  queryElement('#openai-token-metadata').textContent =
    (data.hasOverride
      ? 'Encrypted override active'
      : data.hasEnvironmentToken
        ? 'Using OPENAI_API_KEY'
        : 'No token configured') +
    (data.updatedAt
      ? ' · updated ' + new Date(data.updatedAt).toLocaleString() + ' by ' + data.updatedBy
      : '')
}
async function openPromptSettings() {
  try {
    state.promptSessionName = state.sessionName
    let [endpointResponse, tokenResponse, globalResponse, sessionResponse] = await Promise.all([
        api('/api/admin/openai-endpoint'),
        api('/api/admin/openai-token'),
        api('/api/admin/system-prompt'),
        api('/api/chat/system-prompt?session=' + encodeURIComponent(state.promptSessionName))
      ]),
      endpoint = await endpointResponse.json(),
      token = await tokenResponse.json(),
      globalPrompt = await globalResponse.json(),
      sessionPrompt = await sessionResponse.json()
    renderOpenAIEndpoint(endpoint)
    renderOpenAIToken(token)
    renderPromptSetting(globalPrompt)
    renderSessionPromptSetting(sessionPrompt)
    queryElement('#session-prompt-name').textContent = state.promptSessionName
    queryElement('#chat-view').hidden = true
    queryElement('#prompt-settings-view').hidden = false
    queryElement('#openai-endpoint-status').textContent = ''
    queryElement('#openai-token-status').textContent = ''
    queryElement('#prompt-settings-status').textContent = ''
    queryElement('#session-prompt-settings-status').textContent = ''
  } catch (e) {
    queryElement('#messages').innerHTML = '<div class="empty error">' + esc(e.message) + '</div>'
  }
}
queryElement('#messages').addEventListener('click', (e) => {
  let button = e.target.closest('button[data-component-id]')
  if (!button || button.disabled) return
  let target = button.closest('.body')
  if (button.classList.contains('entity-apply') || button.classList.contains('select-apply')) {
    let input = button.previousElementSibling,
      data = fieldValues(input),
      error = validateField(input, data)
    if (error) {
      let status = target.querySelector('.interaction-status') || document.createElement('div')
      status.className = 'interaction-status status error'
      status.textContent = error
      if (!status.isConnected) target.append(status)
      return
    }
    interaction(target, button.dataset.componentId, data.values)
    return
  }
  interaction(target, button.dataset.componentId)
})
messages.addEventListener(
  'scroll',
  () => {
    if (!state.autoScrolling) setFollowing(nearBottom())
  },
  { passive: true }
)
messages.addEventListener('scrollend', () => {
  stopAutoScroll()
  setFollowing(nearBottom())
})
messages.addEventListener('wheel', stopAutoScroll, { passive: true })
messages.addEventListener('touchstart', stopAutoScroll, { passive: true })
messages.addEventListener('pointerdown', stopAutoScroll, { passive: true })
document.addEventListener('keydown', (e) => {
  if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key))
    stopAutoScroll()
})
queryElement('#jump-bottom').onclick = () => {
  setFollowing(true)
  followBottom()
}
queryElement('.modal-close').onclick = queryElement('.modal-cancel').onclick = () =>
  queryElement('#interaction-modal').close()
queryElement('#interaction-modal-form').addEventListener('submit', (e) => {
  e.preventDefault()
  let form = e.target,
    error = queryElement('.modal-error')
  if (!form.reportValidity()) return
  let fields = [...form.querySelectorAll('[data-modal-field]')].filter(
      (x) => !x.closest('[data-modal-field]') || x.closest('[data-modal-field]') === x
    ),
    data = fields.map(fieldValues)
  for (let i = 0; i < fields.length; i++) {
    let problem = validateField(fields[i], data[i])
    if (problem) {
      error.textContent = problem
      return
    }
  }
  let customId = form.dataset.customId,
    target = state.modalTarget
  queryElement('#interaction-modal').close()
  interaction(target, customId, [], data)
})
queryElement('#session-select').addEventListener('change', async (e) => {
  let previous = state.sessionName,
    name = e.target.value
  clearTimeout(state.pollTimer)
  if (!name) {
    name = (window.prompt('New session name') || '').trim()
    if (!name) {
      e.target.value = previous
      scheduleSessionPoll()
      return
    }
    if (name.length > 100) {
      window.alert('Session name must not exceed 100 characters.')
      e.target.value = previous
      scheduleSessionPoll()
      return
    }
  }
  let version = ++state.loadVersion
  state.sessionName = name
  renderRunControls()
  try {
    let r = await api('/api/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ sessionName: name })
      }),
      data = await r.json()
    if (version !== state.loadVersion || name !== state.sessionName) return
    renderSessionState(data)
    await history(name, version)
  } catch (err) {
    if (version !== state.loadVersion) return
    state.sessionName = previous
    state.loadVersion++
    e.target.value = previous
    scheduleSessionPoll()
    window.alert(err.message)
  } finally {
    renderRunControls()
  }
})
queryElement('#max-tokens').addEventListener(
  'input',
  (e) => (queryElement('#max-tokens-value').value = e.target.value)
)
async function cancelRun(name = state.sessionName, refresh = true) {
  let run = state.runs.get(name)
  if (!run) return false
  queryElement('#cancel-run').disabled = true
  try {
    await api('/api/chat/cancel', {
      method: 'POST',
      body: JSON.stringify({ sessionName: name, runId: run.id })
    })
    if (state.runs.get(name)?.id === run.id) state.runs.delete(name)
    if (refresh && name === state.sessionName) await history(name, state.loadVersion)
    return true
  } finally {
    renderRunControls()
  }
}
async function sendPrompt(prompt, name, settings) {
  if (state.starting.has(name)) return
  clearTimeout(state.pollTimer)
  state.starting.add(name)
  renderRunControls()
  let pending,
    runId,
    failed = false,
    browserStarted = performance.now(),
    browserTiming = {},
    serverTiming,
    assistantIndex
  try {
    if (state.runs.has(name)) await cancelRun(name, true)
    if (name === state.sessionName) {
      state.historySignatures.delete(name)
      queryElement('#messages .empty')?.remove()
      message('user', prompt)
      assistantIndex = messages.querySelectorAll('.assistant').length
      pending = message('assistant', '')
      pending.querySelector('.body').innerHTML = '<span class="status">Starting assistant...</span>'
    }
    let body = { prompt, sessionName: name, ...settings },
      r = await api('/api/chat', { method: 'POST', body: JSON.stringify(body) }),
      reader = r.body.getReader(),
      decoder = new TextDecoder(),
      buffer = ''
    if (settings.debug) browserTiming.responseHeaders = performance.now() - browserStarted
    while (true) {
      let { done, value } = await reader.read()
      if (settings.debug && value?.length && browserTiming.firstByte === undefined)
        browserTiming.firstByte = performance.now() - browserStarted
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      let lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (let line of lines) {
        if (!line) continue
        let update = JSON.parse(line)
        if (update.timing) serverTiming = update.timing
        if (update.runId) {
          runId = update.runId
          state.runs.set(name, { id: runId, local: true })
          state.starting.delete(name)
          if (pending) pending.dataset.runId = runId
          renderRunControls()
        }
        let target =
          runId && name === state.sessionName && state.runs.get(name)?.id === runId
            ? runMessage(runId) || pending
            : null
        if (target && update.payload)
          target.querySelector('.body').innerHTML = payload(update.payload)
        if (settings.debug && target && update.payload && browserTiming.firstRender === undefined)
          browserTiming.firstRender = performance.now() - browserStarted
        if (target && update.error)
          target.querySelector('.body').innerHTML =
            '<span class="status error">' + esc(update.error) + '</span>'
      }
      if (done) break
    }
    if (settings.debug) {
      browserTiming.streamComplete = performance.now() - browserStarted
      if (assistantIndex !== undefined)
        state.debugTimings.set(debugTimingKey(name, assistantIndex), {
          server: serverTiming,
          browser: browserTiming
        })
      let target = runId ? runMessage(runId) : pending
      if (target) renderTiming(target, serverTiming, browserTiming)
    }
  } catch (err) {
    failed = true
    let target = runId ? runMessage(runId) : pending
    if (name === state.sessionName && target?.isConnected)
      target.querySelector('.body').innerHTML =
        '<span class="status error">' + esc(err.message) + '</span>'
  } finally {
    state.starting.delete(name)
    if (runId && state.runs.get(name)?.id === runId) state.runs.delete(name)
    let target = runId && runMessage(runId)
    if (target) delete target.dataset.runId
    if (pending) delete pending.dataset.runId
    if (failed && name === state.sessionName) await history(name, state.loadVersion).catch(() => {})
    if (name === state.sessionName) scheduleSessionPoll()
    renderRunControls()
  }
}
function timingMs(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) + ' ms' : 'n/a'
}
function renderTiming(target, server, browser) {
  let rows = []
  if (server)
    rows.push(
      ...(server.entries || []).map((entry) =>
        entry.durationMs === undefined
          ? entry.name + ': +' + timingMs(entry.startMs)
          : entry.name + ': ' + timingMs(entry.durationMs) + ' (+' + timingMs(entry.startMs) + ')'
      ),
      'server total: ' + timingMs(server.totalMs)
    )
  rows.push(
    'browser response headers: ' + timingMs(browser.responseHeaders),
    'browser first byte: ' + timingMs(browser.firstByte),
    'browser first render: ' + timingMs(browser.firstRender),
    'browser stream complete: ' + timingMs(browser.streamComplete)
  )
  let details = document.createElement('details')
  details.className = 'debug-timing'
  details.open = true
  details.innerHTML = '<summary>Debug timing</summary><pre>' + esc(rows.join('\n')) + '</pre>'
  target.querySelector('.body').append(details)
}
queryElement('#cancel-run').onclick = async () => {
  try {
    await cancelRun()
  } catch (err) {
    window.alert(err.message)
  }
}
queryElement('#composer').addEventListener('submit', async (e) => {
  e.preventDefault()
  let name = state.sessionName
  if (state.starting.has(name)) return
  let prompt = queryElement('#prompt').value.trim()
  if (!prompt) return
  let settings = {
    model: queryElement('#model-select').value.trim(),
    effort: queryElement('#effort').value,
    maxTokens: Number(queryElement('#max-tokens').value),
    toolsEnabled: queryElement('#tools-enabled').checked,
    debug: queryElement('#debug-mode').checked
  }
  queryElement('#prompt').value = ''
  queryElement('#prompt').style.height = 'auto'
  if (prompt === '/clear') {
    try {
      state.starting.add(name)
      renderRunControls()
      await api('/api/chat/clear', { method: 'POST', body: JSON.stringify({ sessionName: name }) })
      for (let key of state.debugTimings.keys())
        if (key.startsWith(name + '\n')) state.debugTimings.delete(key)
      state.runs.delete(name)
      await history(name, state.loadVersion)
    } catch (err) {
      queryElement('#messages').innerHTML =
        '<div class="empty error">' + esc(err.message) + '</div>'
    } finally {
      state.starting.delete(name)
      renderRunControls()
    }
    return
  }
  await sendPrompt(prompt, name, settings)
})
queryElement('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    queryElement('#composer').requestSubmit()
  }
})
queryElement('#prompt').addEventListener('input', (e) => {
  e.target.style.height = 'auto'
  e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
})
queryElement('#login').onclick = () => (location.href = '/auth/login')
queryElement('#admin-prompt').onclick = openPromptSettings
queryElement('#prompt-back').onclick = () => {
  queryElement('#prompt-settings-view').hidden = true
  queryElement('#chat-view').hidden = false
}
queryElement('#prompt-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    let prompt = e.target.elements.prompt.value,
      r = await api('/api/admin/system-prompt', {
        method: 'PUT',
        body: JSON.stringify({ prompt })
      }),
      data = await r.json()
    renderPromptSetting(data)
    queryElement('#prompt-settings-status').textContent = 'Saved'
  } catch (err) {
    queryElement('#prompt-settings-status').textContent = err.message
  }
})
queryElement('#prompt-reset').onclick = async () => {
  try {
    let r = await api('/api/admin/system-prompt/reset', { method: 'POST' }),
      data = await r.json()
    renderPromptSetting(data)
    queryElement('#prompt-settings-status').textContent = 'Reset to default'
  } catch (err) {
    queryElement('#prompt-settings-status').textContent = err.message
  }
}
queryElement('#openai-endpoint-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    let endpoint = e.target.elements.endpoint.value,
      r = await api('/api/admin/openai-endpoint', {
        method: 'PUT',
        body: JSON.stringify({ endpoint })
      }),
      data = await r.json()
    renderOpenAIEndpoint(data)
    queryElement('#openai-endpoint-status').textContent = 'Saved'
    await loadModels()
  } catch (err) {
    queryElement('#openai-endpoint-status').textContent = err.message
  }
})
queryElement('#openai-endpoint-reset').onclick = async () => {
  try {
    let r = await api('/api/admin/openai-endpoint/reset', { method: 'POST' }),
      data = await r.json()
    renderOpenAIEndpoint(data)
    queryElement('#openai-endpoint-status').textContent = 'Reset'
    await loadModels()
  } catch (err) {
    queryElement('#openai-endpoint-status').textContent = err.message
  }
}
queryElement('#openai-token-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    let token = e.target.elements.token.value,
      r = await api('/api/admin/openai-token', { method: 'PUT', body: JSON.stringify({ token }) }),
      data = await r.json()
    renderOpenAIToken(data)
    queryElement('#openai-token-status').textContent = 'Saved'
    await loadModels()
  } catch (err) {
    queryElement('#openai-token-status').textContent = err.message
  }
})
queryElement('#openai-token-reset').onclick = async () => {
  try {
    let r = await api('/api/admin/openai-token/reset', { method: 'POST' }),
      data = await r.json()
    renderOpenAIToken(data)
    queryElement('#openai-token-status').textContent = 'Removed'
    await loadModels()
  } catch (err) {
    queryElement('#openai-token-status').textContent = err.message
  }
}
queryElement('#session-prompt-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    let prompt = e.target.elements.prompt.value,
      r = await api('/api/chat/system-prompt', {
        method: 'PUT',
        body: JSON.stringify({ sessionName: state.promptSessionName, prompt })
      }),
      data = await r.json()
    renderSessionPromptSetting(data)
    queryElement('#session-prompt-settings-status').textContent = 'Saved'
  } catch (err) {
    queryElement('#session-prompt-settings-status').textContent = err.message
  }
})
queryElement('#session-prompt-reset').onclick = async () => {
  try {
    let r = await api('/api/chat/system-prompt/reset', {
        method: 'POST',
        body: JSON.stringify({ sessionName: state.promptSessionName })
      }),
      data = await r.json()
    renderSessionPromptSetting(data)
    queryElement('#session-prompt-settings-status').textContent = 'Removed'
  } catch (err) {
    queryElement('#session-prompt-settings-status').textContent = err.message
  }
}
queryElement('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  let f = e.target,
    data = Object.fromEntries(new FormData(f))
  data.enabled = f.elements.enabled.checked
  data.automaticLogin = f.elements.automaticLogin.checked
  try {
    let r = await api('/api/admin/oidc', { method: 'PUT', body: JSON.stringify(data) }),
      saved = await r.json()
    queryElement('#settings-status').textContent = 'Saved'
    queryElement('#secret-state').textContent = saved.hasClientSecret ? 'A secret is stored.' : ''
    if (state.session.oidcSetupRequired) await session()
  } catch (err) {
    queryElement('#settings-status').textContent = err.message
  }
})
session().catch((e) => (queryElement('#auth-error').textContent = e.message))
