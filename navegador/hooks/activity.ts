// O que o agente faz no navegador, lido dos comandos Bash que chamam o
// terminal-browser. Puro: sem `$`, pra ser testado direto.

export type StepStatus = 'next' | 'working' | 'done' | 'failed'

export type Step = {
  label: string
  status: StepStatus
  startedAt: number
  ms: number | null
  /** Verificação (wait --text, is visible…): entra no placar do relatório. */
  check: boolean
  /** Índice do capítulo (um por comando Bash, com a intenção dele). */
  chapter: number
}

export type Parsed =
  | { kind: 'step'; label: string; check: boolean }
  | { kind: 'done' }
  /** tb-run: roteiro cujos passos só se conhecem pelos eventos (phase 'add'). */
  | { kind: 'script' }

const VERBS: Record<string, string> = {
  click: 'clicar',
  dblclick: 'clicar duas vezes',
  fill: 'digitar',
  type: 'digitar',
  hover: 'passar o mouse',
  check: 'marcar',
  uncheck: 'desmarcar',
  select: 'selecionar',
  focus: 'focar',
  press: 'tecla',
  snapshot: 'ler a página',
  screenshot: 'capturar a tela',
  eval: 'rodar JS',
  scroll: 'rolar',
  scrollintoview: 'rolar até',
  wait: 'esperar',
  back: 'voltar',
  forward: 'avançar',
  reload: 'recarregar',
  highlight: 'destacar',
  get: 'ler',
  open: 'abrir',
  goto: 'abrir',
  navigate: 'abrir',
  tab: 'aba',
  webmcp: 'webmcp',
}

// Comandos cujo primeiro argumento é um alvo que vale mostrar.
const SHOWS_ARG = new Set([
  'click', 'dblclick', 'fill', 'type', 'hover', 'check', 'uncheck', 'select',
  'focus', 'press', 'scrollintoview', 'highlight', 'get', 'open', 'goto',
  'navigate', 'tab', 'webmcp',
])

/** Separa em palavras respeitando aspas simples e duplas. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let has = false
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

/** Divide um comando de shell nos trechos ligados por ; && || | e quebra de linha. */
function segments(command: string): string[] {
  return command.split(/\n|;|&&|\|\||\|/)
}

function shortUrl(raw: string): string {
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// `wait` e `is` com condição viram verificação; `wait 500` é só pausa.
function checkLabel(words: string[]): string | null {
  const [cmd = '', a = '', b = ''] = words
  if (cmd === 'is' && a && b) {
    const what: Record<string, string> = { visible: 'visível', checked: 'marcado', enabled: 'habilitado' }
    return `verificar ${what[a] ?? a}: ${clip(b, 36)}`
  }
  if (cmd !== 'wait') return null
  if (a === '--text' && b) return `verificar texto “${clip(b, 36)}”`
  if (a === '--url' && b) return `verificar URL ${clip(shortUrl(b), 36)}`
  if (a === '--fn' && b) return `verificar ${clip(b, 40)}`
  return null
}

function labelFor(words: string[]): string {
  const [cmd = '', arg = ''] = words
  const verb = VERBS[cmd] ?? cmd
  if (cmd === 'wait' && /^\d+$/.test(arg)) return `esperar ${arg}ms`
  // Texto digitado diz mais que o seletor do campo.
  const typed = words[2]
  if ((cmd === 'fill' || cmd === 'type' || cmd === 'select') && typed) return `${verb} “${clip(typed, 36)}”`
  if (!SHOWS_ARG.has(cmd) || !arg) return verb
  // Referência interna (@e12) não diz nada a quem assiste: só o verbo, e o
  // nome do elemento entra quando o wrapper avisa (relabel).
  if (/^(@e\d+|ref=\d+)$/.test(arg)) return verb
  const target = cmd === 'open' || cmd === 'goto' || cmd === 'navigate' ? shortUrl(arg) : arg
  return `${verb} ${clip(target, 40)}`
}

// Corpo de heredoc é texto, não comando (um script que só cita o CLI).
function withoutHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '')
}

// Só conta quando o terminal-browser é o comando do trecho: antes dele, só
// atribuições (VAR=x) e prefixos como env/time/exec. `echo terminal-browser …`
// não é passo.
const PREFIX = /^([A-Za-z_]\w*=.*|env|time|exec|command|nohup)$/
function commandAt(words: string[], name = 'terminal-browser'): number {
  const at = words.findIndex(word => word === name || word.endsWith(`/${name}`))
  return at >= 0 && words.slice(0, at).every(word => PREFIX.test(word)) ? at : -1
}

/** Os passos de navegador que um comando Bash vai fazer, na ordem. */
export function parseBrowserSteps(command: string): Parsed[] {
  const steps: Parsed[] = []
  for (const segment of segments(withoutHeredocs(command))) {
    const words = tokenize(segment)
    if (commandAt(words, 'tb-run') >= 0 && !words.includes('--help') && !words.includes('-h')) {
      steps.push({ kind: 'script' })
      continue
    }
    const look = commandAt(words, 'tb-look')
    if (look >= 0 && !words.includes('--help') && !words.includes('-h')) {
      const rest = words.slice(look + 1)
      const scope = rest.find((w, i) => !w.startsWith('-') && !['--linhas', '--lines', '--browser'].includes(rest[i - 1] ?? ''))
      steps.push({ kind: 'step', label: scope ? `ler a página: ${clip(scope, 36)}` : 'ler a página', check: false })
      continue
    }
    const at = commandAt(words)
    if (at < 0) continue
    const sub = words[at + 1]
    if (sub === 'action') {
      const rest = words.slice(at + 2)
      if (rest[0] === 'done') {
        steps.push({ kind: 'done' })
        continue
      }
      const dash = rest.indexOf('--')
      if (dash < 0) continue
      const inner = rest.slice(dash + 1)
      if (inner.length === 0) continue
      const check = checkLabel(inner)
      steps.push({ kind: 'step', label: check ?? labelFor(inner), check: check !== null })
    } else if (sub === 'open' || sub === 'new-tab') {
      const url = words.slice(at + 2).find(word => !word.startsWith('-'))
      const verb = sub === 'open' ? 'abrir o navegador' : 'nova aba'
      steps.push({ kind: 'step', label: url ? `${verb} ${clip(shortUrl(url), 40)}` : verb, check: false })
    }
  }
  return steps
}

/** Um evento que o wrapper tb-agent-browser grava por ação, em events.jsonl. */
/** `phase: 'start'` chega antes da ação, só com o nome do alvo; o resto, depois. */
/** `phase: 'add'` (tb-run) cria um passo novo com `label`/`check` antes de rodá-lo. */
/** `phase: 'chapter'` (tb-run) abre uma etapa nova no card, com `label` de título. */
/** `phase: 'rec'` (tb-run --video) liga (`label: 'on'`) ou desliga o sinal de gravação no card. */
export type ActionEvent = {
  cmd: string
  ok: boolean
  out: string
  target: string
  phase: 'start' | 'end' | 'add' | 'chapter' | 'rec'
  label: string
  check: boolean
}

export function parseEvents(text: string): ActionEvent[] {
  const out: ActionEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as Partial<ActionEvent>
      if (typeof v.cmd === 'string' && typeof v.ok === 'boolean') {
        out.push({
          cmd: v.cmd,
          ok: v.ok,
          out: typeof v.out === 'string' ? v.out : '',
          target: typeof v.target === 'string' ? v.target : '',
          phase: v.phase === 'start' || v.phase === 'add' || v.phase === 'chapter' || v.phase === 'rec' ? v.phase : 'end',
          label: typeof v.label === 'string' ? v.label : '',
          check: v.check === true,
        })
      }
    } catch {}
  }
  return out
}

// Só ações sobre um elemento ganham o nome dele no lugar do seletor.
const ELEMENT_VERBS = ['clicar', 'clicar duas vezes', 'passar o mouse', 'marcar', 'desmarcar', 'focar', 'rolar até', 'destacar']

/**
 * Troca o seletor do fim do rótulo ("clicar @e12", "marcar .todo li input")
 * pelo nome do elemento que o wrapper achou: clicar “Active”.
 */
export function relabel(label: string, target: string): string {
  const name = target.replace(/\s+/g, ' ').trim()
  if (!name) return label
  // O verbo é o prefixo conhecido mais longo; o resto é o seletor.
  const verb = ELEMENT_VERBS
    .filter(v => label.startsWith(`${v} `))
    .sort((a, b) => b.length - a.length)[0]
  if (!verb) return ELEMENT_VERBS.includes(label) ? `${label} “${clip(name, 36)}”` : label
  const rest = label.slice(verb.length + 1)
  if (rest.startsWith('“') || !/^(@e\d+|ref=\d+|text=|xpath=|[.#\[a-z*])/i.test(rest)) return label
  return `${verb} “${clip(name, 36)}”`
}

/** "0.4s", "12s", "1m05s". */
// Mora no card.tsx: o módulo do card não importa valores de outros arquivos.
export { formatMs } from './card.tsx'
