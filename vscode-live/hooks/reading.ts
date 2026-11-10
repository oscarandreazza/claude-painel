// O que o Claude lê e busca pelo terminal: muitas leituras e buscas são
// comandos (sed -n, head, cat, rg, grep, git grep), não as ferramentas Read e
// Grep.
// Daqui saem só caminhos e números de linha, nunca o conteúdo.

export type ShellRead = { file: string; start: number; end: number }
export type ShellSearch = { pattern: string; paths: string[] }

// Teto de "o arquivo inteiro" (cat, bat, nl): a extensão corta pelo tamanho
// real do arquivo.
const WHOLE_FILE = 100_000
// Arquivos achados por busca que acendem no Explorer: o resto fica de fora
// (uma busca ampla não pinta o projeto inteiro).
const MAX_HITS = 30

function resolvePath(file: string, cwd: string, home: string): string {
  if (file.startsWith('/')) return file
  if (file.startsWith('~/')) return `${home}${file.slice(1)}`
  const out: string[] = []
  for (const part of `${cwd.replace(/\/+$/, '')}/${file.replace(/^\.\//, '')}`.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return `/${out.join('/')}`
}

// Divide em palavras respeitando aspas simples e duplas.
function words(segment: string): string[] {
  const out: string[] = []
  for (const m of segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

// Os pedaços do comando entre &&, ;, || e |: cada um é um comando. Dentro
// de aspas não divide (o `&&` de `awk 'NR>=10 && NR<=40'` é do programa).
function segments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (quote) {
      if (char === quote) quote = undefined
      current += char
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === ';' || char === '|' || (char === '&' && command[i + 1] === '&')) {
      if (char !== ';' && command[i + 1] === char) i++
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out.map(part => part.trim()).filter(Boolean)
}

const notFlag = (word: string) => !word.startsWith('-')

export function shellReads(command: string, cwd: string, home: string): ShellRead[] {
  const out: ShellRead[] = []
  for (const segment of segments(command)) {
    const [tool, ...args] = words(segment)
    if (tool === 'sed') {
      const range = args.map(a => a.match(/^(\d+)(?:,(\d+))?p$/)).find(Boolean)
      const file = args.filter(notFlag).at(-1)
      if (range && file && !/^\d+(,\d+)?p$/.test(file)) {
        const start = Number(range[1])
        out.push({ file: resolvePath(file, cwd, home), start, end: Number(range[2] ?? start) })
      }
    } else if (tool === 'head') {
      let count = 10
      const files: string[] = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? ''
        if (arg === '-n' || arg === '-c') count = arg === '-n' ? Number(args[++i]) || count : (i++, count)
        else if (/^-n?\d+$/.test(arg)) count = Number(arg.replace(/^-n?/, ''))
        else if (notFlag(arg)) files.push(arg)
      }
      for (const file of files) out.push({ file: resolvePath(file, cwd, home), start: 1, end: count })
    } else if (tool === 'awk') {
      // awk 'NR>=10 && NR<=40' arquivo, ou awk 'NR==7' arquivo.
      const program = args.find(notFlag) ?? ''
      const from = program.match(/NR\s*>=?\s*(\d+)/)
      const to = program.match(/NR\s*<=?\s*(\d+)/)
      const only = program.match(/NR\s*==\s*(\d+)/)
      const file = args.filter(notFlag).at(-1)
      if (file && file !== program && (from || to || only)) {
        const start = Number(only?.[1] ?? from?.[1] ?? 1)
        out.push({ file: resolvePath(file, cwd, home), start, end: Number(only?.[1] ?? to?.[1] ?? WHOLE_FILE) })
      }
    } else if (tool === 'cat' || tool === 'bat' || tool === 'nl') {
      for (const file of args.filter(notFlag)) out.push({ file: resolvePath(file, cwd, home), start: 1, end: WHOLE_FILE })
    }
  }
  return out
}

// rg/grep/git grep: o padrão é o primeiro argumento que não é opção (ou o de
// -e); o resto são caminhos.
export function shellSearch(command: string): string | undefined {
  for (const segment of segments(command)) {
    const all = words(segment)
    const start = all[0] === 'git' && all[1] === 'grep' ? 2 : ['rg', 'grep', 'egrep', 'ag'].includes(all[0] ?? '') ? 1 : -1
    if (start < 0) continue
    const args = all.slice(start)
    const flagged = args.findIndex(a => a === '-e' || a === '--regexp')
    if (flagged >= 0 && args[flagged + 1]) return args[flagged + 1]
    const pattern = args.find(notFlag)
    if (pattern) return pattern
  }
  return undefined
}

// Arquivos que aparecem na saída de uma busca ("caminho:linha:…", "caminho:…"
// ou só "caminho" com -l). Só candidatos: quem chama confere se existem.
export function searchHits(output: string, cwd: string, home: string): { file: string; line?: number }[] {
  const seen = new Map<string, number | undefined>()
  for (const line of output.split('\n')) {
    const m = line.match(/^([^\s:][^:]*?):(\d+):/) ?? line.match(/^([^\s:][^:]*?):/) ?? line.match(/^([^\s:]+\.[A-Za-z0-9]+)$/)
    if (!m || !m[1] || /^\d+$/.test(m[1])) continue
    const file = resolvePath(m[1], cwd, home)
    if (!seen.has(file)) seen.set(file, m[2] ? Number(m[2]) : undefined)
    if (seen.size >= MAX_HITS) break
  }
  return [...seen].map(([file, line]) => ({ file, line }))
}
