import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const script = readFileSync('assets/web/personas.js', 'utf8')
type Persona = { name: string; prompt: string }

// A minimal DOM double for the trusted static UI script, not an untrusted-code sandbox.
class Element {
  value = ''
  textContent = ''
  className = ''
  disabled = false
  readOnly = false
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  children: Element[] = []
  listeners = new Map<string, (event: unknown) => void>()
  focus = vi.fn()
  constructor(readonly tag = 'div') {}
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  append(...elements: Element[]) {
    this.children.push(...elements)
  }
  replaceChildren() {
    this.children = []
  }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag)
    ])
  }
  addEventListener(name: string, handler: (event: unknown) => void) {
    this.listeners.set(name, handler)
  }
  emit(name: string, event: unknown = {}) {
    this.listeners.get(name)?.(event)
  }
}

async function editor(initial: Persona[] = []) {
  let saved = initial.map((item) => ({ ...item }))
  const elements = new Map<string, Element>()
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new Element())
    return elements.get(selector)!
  }
  const window = new Element()
  const confirm = vi.fn(() => true)
  const clipboard = vi.fn().mockResolvedValue(undefined)
  const fetch = vi.fn(async (_url: string, options: { method: string; body?: string }) => {
    const body = options.body ? (JSON.parse(options.body) as Persona) : null
    if (options.method === 'PUT' && body)
      saved = [...saved.filter((item) => item.name !== body.name), body]
    if (options.method === 'DELETE' && body) saved = saved.filter((item) => item.name !== body.name)
    return {
      ok: true,
      json: async () => ({ personas: saved.map((item) => ({ ...item })), csrfToken: 'test-csrf' })
    }
  })
  runInNewContext(script, {
    document: { querySelector: element, createElement: (tag: string) => new Element(tag) },
    window,
    confirm,
    fetch,
    navigator: { clipboard: { writeText: clipboard } }
  })
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
  const input = (name: string, value: string) => {
    element(name).value = value
    element('#editor').emit('input')
  }
  const submit = () => element('#editor').emit('submit', { preventDefault() {} })
  await settle()
  return {
    element,
    input,
    submit,
    settle,
    confirm,
    fetch,
    window,
    clipboard,
    saved: () => saved,
    externalChange: (value: Persona[]) => {
      saved = value
    }
  }
}

describe('persona editor user experience', () => {
  it('searches names and content, shows a selection, and updates the usage and character count', async () => {
    const ui = await editor([
      { name: 'cat', prompt: 'a friendly cat' },
      { name: 'space', prompt: 'a curious explorer' }
    ])
    expect(ui.element('#persona-count').textContent).toBe('2')
    ui.element('#search').value = 'explorer'
    ui.element('#search').emit('input')
    expect(ui.element('#personas').children).toHaveLength(1)
    ui.element('#personas').children[0]!.emit('click')
    expect(ui.element('#name').value).toBe('space')
    expect(ui.element('#name').readOnly).toBe(true)
    expect(ui.element('#personas').children[0]!.dataset.selected).toBe('true')
    expect(ui.element('#character-count').textContent).toBe('18 / 4000')
    expect(ui.element('#usage').textContent).toBe('@role <|space|> 안녕')
    expect(ui.element('#save').disabled).toBe(true)
    ui.input('#prompt', 'updated character')
    expect(ui.element('#save').disabled).toBe(false)
    expect(ui.element('#save-state').dataset.dirty).toBe('true')
  })

  it('protects unsaved changes when switching characters, creating a new one, or leaving', async () => {
    const ui = await editor([{ name: 'cat', prompt: 'meow' }])
    ui.input('#name', 'draft')
    ui.input('#prompt', 'keep this')
    ui.confirm.mockReturnValue(false)
    ui.element('#personas').children[0]!.emit('click')
    ui.element('#new').emit('click')
    expect(ui.element('#name').value).toBe('draft')
    expect(ui.element('#prompt').value).toBe('keep this')
    const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined }
    ui.window.emit('beforeunload', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe('')
    expect(ui.fetch).toHaveBeenCalledTimes(1)
  })

  it('creates and saves a valid draft, then enables copy and duplicate without overwriting the original', async () => {
    const ui = await editor()
    ui.input('#name', 'cat')
    expect(ui.element('#save').disabled).toBe(true)
    ui.input('#prompt', 'meow')
    ui.submit()
    await ui.settle()
    expect(ui.saved()).toEqual([{ name: 'cat', prompt: 'meow' }])
    expect(ui.element('#save').disabled).toBe(true)
    ui.element('#copy-usage').emit('click')
    await ui.settle()
    expect(ui.clipboard).toHaveBeenCalledWith('@role <|cat|> 안녕')
    ui.element('#duplicate').emit('click')
    expect(ui.element('#name').value).toBe('cat_복사')
    expect(ui.element('#name').readOnly).toBe(false)
    expect(ui.element('#prompt').value).toBe('meow')
    expect(ui.saved()).toEqual([{ name: 'cat', prompt: 'meow' }])
    ui.submit()
    await ui.settle()
    expect(ui.saved()).toHaveLength(2)
  })

  it('does not silently overwrite a name collision or another visitor’s changes', async () => {
    const ui = await editor([{ name: 'cat', prompt: 'original' }])
    ui.input('#name', 'cat')
    ui.input('#prompt', 'replacement')
    ui.submit()
    expect(ui.element('#status').dataset.tone).toBe('error')
    expect(ui.saved()[0]!.prompt).toBe('original')
    ui.confirm.mockReturnValue(true)
    ui.element('#personas').children[0]!.emit('click')
    ui.input('#prompt', 'my version')
    ui.externalChange([{ name: 'cat', prompt: 'someone else’s version' }])
    ui.confirm.mockReturnValue(false)
    ui.submit()
    await ui.settle()
    expect(ui.saved()[0]!.prompt).toBe('someone else’s version')
    expect(ui.element('#prompt').value).toBe('my version')
    expect(ui.element('#save').disabled).toBe(false)
  })

  it('refreshes without losing a draft and confirms before deleting a saved persona', async () => {
    const ui = await editor([{ name: 'cat', prompt: 'original' }])
    ui.element('#personas').children[0]!.emit('click')
    ui.input('#prompt', 'draft')
    ui.element('#refresh').emit('click')
    await ui.settle()
    expect(ui.element('#prompt').value).toBe('draft')
    ui.confirm.mockReturnValueOnce(false)
    ui.element('#delete').emit('click')
    expect(ui.saved()).toHaveLength(1)
    ui.element('#delete').emit('click')
    await ui.settle()
    expect(ui.saved()).toEqual([])
    expect(ui.element('#name').value).toBe('')
    expect(ui.element('#delete').disabled).toBe(true)
  })
})
