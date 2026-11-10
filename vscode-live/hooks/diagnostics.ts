// Leitores da saída de typecheck, lint e testes (tsc, eslint stylish, vitest,
// jest): tiram de cada erro só o arquivo, a linha, a coluna e a mensagem. É
// isso que vai pra ponte (nunca a saída inteira), e a extensão transforma em
// marcações no editor.

export type DiagSource = 'tsc' | 'eslint' | 'testes'
export type Diag = {
  file: string
  line: number
  col: number
  severity: 'error' | 'warning'
  message: string
  code?: string
}

// Teto de problemas por ferramenta e de tamanho da mensagem: o bastante pra
// marcar o editor sem pesar a ponte.
const MAX_ITEMS = 300
const MAX_MESSAGE = 300
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

const clip = (text: string) => (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text)

function resolvePath(file: string, cwd: string, home: string): string {
  if (file.startsWith('/')) return file
  if (file.startsWith('~/')) return `${home}${file.slice(1)}`
  const parts = `${cwd.replace(/\/+$/, '')}/${file.replace(/^\.\//, '')}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return `/${out.join('/')}`
}

// A pasta onde o comando roda: o último `cd <pasta> &&` do comando, contado a
// partir da pasta da sessão.
export function commandCwd(command: string, sessionCwd: string, home: string): string {
  let cwd = sessionCwd
  for (const match of command.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))\s*(?=&&|;|$)/g)) {
    cwd = resolvePath(match[1] ?? match[2] ?? match[3] ?? '.', cwd, home)
  }
  return cwd
}

// Quais ferramentas o comando roda, pra apagar as marcações delas quando ele
// passa limpo. Só pelo nome: `npm run build` não apaga nada.
export function sourcesRun(command: string): Set<DiagSource> {
  const out = new Set<DiagSource>()
  if (/\b(?:vue-)?tsc\b|\btype-?check\b/.test(command)) out.add('tsc')
  if (/\beslint\b|\brun\s+lint\b|\blint\b/.test(command)) out.add('eslint')
  if (/\bvitest\b|\bjest\b|\brun\s+test\b|\bnpm\s+test\b|\bpnpm\s+test\b|\byarn\s+test\b/.test(command)) out.add('testes')
  return out
}

function parseTsc(text: string, cwd: string, home: string): Diag[] {
  const out: Diag[] = []
  const patterns = [
    /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/gm,
    /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/gm,
  ]
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      out.push({
        file: resolvePath((m[1] ?? '').trim(), cwd, home),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: m[4] === 'warning' ? 'warning' : 'error',
        code: m[5],
        message: clip(m[6] ?? ''),
      })
    }
  }
  return out
}

// ESLint "stylish": o caminho do arquivo numa linha, os problemas indentados
// embaixo ("  12:5  error  mensagem  regra").
function parseEslint(text: string, cwd: string, home: string): Diag[] {
  const out: Diag[] = []
  let file: string | undefined
  for (const line of text.split('\n')) {
    const problem = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/)
    if (problem && file) {
      out.push({
        file,
        line: Number(problem[1]),
        col: Number(problem[2]),
        severity: problem[3] === 'warning' ? 'warning' : 'error',
        message: clip(problem[4] ?? ''),
        code: problem[5],
      })
      continue
    }
    if (/^\S.*\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(line.trim()) && !line.startsWith(' ')) {
      file = resolvePath(line.trim(), cwd, home)
    } else if (line.trim() === '') {
      file = undefined
    }
  }
  return out
}

// Vitest: blocos " FAIL  arquivo > suite > teste", com o erro e a linha
// " ❯ arquivo:linha:coluna". Jest: "● suite › teste" e "at … (arquivo:l:c)".
function parseTests(text: string, cwd: string, home: string): Diag[] {
  const out: Diag[] = []
  for (const block of text.split(/^\s*FAIL\s+/m).slice(1)) {
    const header = block.split('\n')[0] ?? ''
    if (!header.includes('>')) continue
    const name = header.split('>').slice(1).map(part => part.trim()).join(' › ')
    const error = block.split('\n').find(line => /Error\b|expected/i.test(line))?.trim()
    const at = block.match(/❯\s+([^\s:]+):(\d+):(\d+)/)
    if (!at) continue
    out.push({
      file: resolvePath(at[1] ?? '', cwd, home),
      line: Number(at[2]),
      col: Number(at[3]),
      severity: 'error',
      message: clip(`teste falhou: ${name}${error ? ` — ${error}` : ''}`),
    })
  }
  for (const block of text.split(/^\s*● /m).slice(1)) {
    const name = (block.split('\n')[0] ?? '').trim()
    const at = [...block.matchAll(/\(([^()\s]+?):(\d+):(\d+)\)/g)].find(m => !(m[1] ?? '').includes('node_modules'))
    if (!name || !at) continue
    const error = block.split('\n').slice(1).map(line => line.trim()).find(line => line !== '')
    out.push({
      file: resolvePath(at[1] ?? '', cwd, home),
      line: Number(at[2]),
      col: Number(at[3]),
      severity: 'error',
      message: clip(`teste falhou: ${name}${error ? ` — ${error}` : ''}`),
    })
  }
  return out
}

// Os problemas achados na saída, por ferramenta. Uma ferramenta que o comando
// rodou e não deixou problema aparece com lista vazia (apaga as marcações).
export function parseDiagnostics(command: string, output: string, cwd: string, home: string): Map<DiagSource, Diag[]> {
  const text = output.replace(ANSI, '')
  const found = new Map<DiagSource, Diag[]>([
    ['tsc', parseTsc(text, cwd, home)],
    ['eslint', parseEslint(text, cwd, home)],
    ['testes', parseTests(text, cwd, home)],
  ])
  const ran = sourcesRun(command)
  const out = new Map<DiagSource, Diag[]>()
  for (const [source, items] of found) {
    // A mesma saída pode chegar duas vezes (stdout e texto de erro).
    const unique = [...new Map(items.map(d => [`${d.file}:${d.line}:${d.col}:${d.message}`, d])).values()]
    if (unique.length > 0 || ran.has(source)) out.set(source, unique.slice(0, MAX_ITEMS))
  }
  return out
}
