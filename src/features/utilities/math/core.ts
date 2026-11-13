type Token =
  | { type: 'number'; value: number }
  | { type: 'identifier'; value: string }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' | '%' | '^' }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'comma' }

const constants: Record<string, number> = {
  e: Math.E,
  pi: Math.PI,
  tau: Math.PI * 2
}

const functions: Record<string, (...args: number[]) => number> = {
  abs: (value) => Math.abs(oneArg('abs', value)),
  acos: (value) => Math.acos(oneArg('acos', value)),
  asin: (value) => Math.asin(oneArg('asin', value)),
  atan: (value) => Math.atan(oneArg('atan', value)),
  ceil: (value) => Math.ceil(oneArg('ceil', value)),
  cos: (value) => Math.cos(oneArg('cos', value)),
  exp: (value) => Math.exp(oneArg('exp', value)),
  floor: (value) => Math.floor(oneArg('floor', value)),
  ln: (value) => Math.log(oneArg('ln', value)),
  log: (value) => Math.log10(oneArg('log', value)),
  max: (...args) => variableArgs('max', args, Math.max),
  min: (...args) => variableArgs('min', args, Math.min),
  round: (value) => Math.round(oneArg('round', value)),
  sin: (value) => Math.sin(oneArg('sin', value)),
  sqrt: (value) => Math.sqrt(oneArg('sqrt', value)),
  tan: (value) => Math.tan(oneArg('tan', value))
}

function oneArg(name: string, value: number | undefined): number {
  if (typeof value !== 'number') throw new Error(`${name} arg`)
  return value
}

function variableArgs(name: string, args: number[], fn: (...values: number[]) => number): number {
  if (args.length === 0) throw new Error(`${name} arg`)
  return fn(...args)
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < input.length) {
    const char = input[index]

    if (/\s/.test(char)) {
      index++
      continue
    }

    if (/[0-9.]/.test(char)) {
      const match = input.slice(index).match(/^(?:\d+(?:\.\d+)?|\.\d+)/)
      if (!match) throw new Error('bad num')
      tokens.push({ type: 'number', value: Number(match[0]) })
      index += match[0].length
      continue
    }

    if (/[a-z]/i.test(char)) {
      const match = input.slice(index).match(/^[a-z]+/i)
      if (!match) throw new Error('bad id')
      tokens.push({ type: 'identifier', value: match[0].toLowerCase() })
      index += match[0].length
      continue
    }

    if ('+-*/%^'.includes(char)) {
      tokens.push({ type: 'operator', value: char as '+' | '-' | '*' | '/' | '%' | '^' })
      index++
      continue
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char })
      index++
      continue
    }

    if (char === ',') {
      tokens.push({ type: 'comma' })
      index++
      continue
    }

    throw new Error('bad char')
  }

  return tokens
}

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.parseExpression()
    if (this.peek()) throw new Error('extra')
    return value
  }

  private parseExpression(): number {
    return this.parseAdditive()
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative()

    while (true) {
      const token = this.peek()
      if (token?.type !== 'operator' || (token.value !== '+' && token.value !== '-')) return value
      this.index++
      const right = this.parseMultiplicative()
      value = token.value === '+' ? value + right : value - right
    }
  }

  private parseMultiplicative(): number {
    let value = this.parsePower()

    while (true) {
      const token = this.peek()
      if (token?.type !== 'operator' || !['*', '/', '%'].includes(token.value)) return value
      this.index++
      const right = this.parsePower()

      if (token.value === '*') value *= right
      if (token.value === '/') value /= right
      if (token.value === '%') value %= right
    }
  }

  private parsePower(): number {
    const left = this.parseUnary()
    const token = this.peek()
    if (token?.type === 'operator' && token.value === '^') {
      this.index++
      return left ** this.parsePower()
    }
    return left
  }

  private parseUnary(): number {
    const token = this.peek()
    if (token?.type === 'operator' && (token.value === '+' || token.value === '-')) {
      this.index++
      const value = this.parseUnary()
      return token.value === '-' ? -value : value
    }
    return this.parsePrimary()
  }

  private parsePrimary(): number {
    const token = this.next()
    if (!token) throw new Error('no expr')

    if (token.type === 'number') return token.value

    if (token.type === 'identifier') {
      const next = this.peek()
      if (next?.type === 'paren' && next.value === '(') return this.parseFunction(token.value)
      const constant = constants[token.value]
      if (typeof constant === 'number') return constant
      throw new Error(`bad id: ${token.value}`)
    }

    if (token.type === 'paren' && token.value === '(') {
      const value = this.parseExpression()
      const close = this.next()
      if (!close || close.type !== 'paren' || close.value !== ')') throw new Error('no )')
      return value
    }

    throw new Error('bad tok')
  }

  private parseFunction(name: string): number {
    const open = this.next()
    if (!open || open.type !== 'paren' || open.value !== '(') throw new Error('no (')

    const args: number[] = []
    const close = this.peek()
    if (close?.type === 'paren' && close.value === ')') {
      this.index++
    } else {
      while (true) {
        args.push(this.parseExpression())
        const token = this.next()
        if (!token) throw new Error('no )')
        if (token.type === 'paren' && token.value === ')') break
        if (token.type !== 'comma') throw new Error('bad args')
      }
    }

    const fn = functions[name]
    if (!fn) throw new Error(`bad fn: ${name}`)
    const value = fn(...args)
    if (!Number.isFinite(value)) throw new Error('no num')
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index]
    this.index++
    return token
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('no num')
  if (Object.is(value, -0)) return '0'
  if (Number.isInteger(value)) return String(value)
  return Number(value.toPrecision(15)).toString()
}

export function evaluateMath(expression: string): number {
  const trimmed = expression.trim()
  if (!trimmed) throw new Error('no expr')
  return new Parser(tokenize(trimmed)).parse()
}

export function evaluateMathString(expression: string): string {
  return formatNumber(evaluateMath(expression))
}
