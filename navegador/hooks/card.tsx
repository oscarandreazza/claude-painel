/* @jsx h */
// Card de status embaixo do navegador, como módulo de Client: anima o spinner
// e o tempo sozinho, sem redesenhar o painel (e a imagem do navegador) a cada
// 120 ms. O register só manda props novas quando os dados mudam.
//
// Sem import de valor de outro arquivo do plugin: o módulo de superfície roda
// no fio de desenho. Tipos, sim (somem na compilação).
import type { ClientSurface } from 'claude-code'
import type { Step } from './activity.ts'

export type Req = { m: string; u: string; s: number | null; t: string }
export type ConsoleMsg = { type: string; text: string }

export type CardProps = {
  cols: number
  /** Fundo pintado do card (opção `background` do plugin). */
  background: string
  rows: number
  collapsed: boolean
  /** $.clock.now() quando as props foram montadas (ms desde a época). */
  now: number
  url: string | null
  steps: Step[]
  finishedAt: number | null
  intent: string | null
  chapters: string[]
  requests: Req[]
  console: ConsoleMsg[]
}

// Card de status: borda (2), título, barra e 6 linhas.
export const STATUS_ROWS = 10
// Recolhido: só título e barra (4 linhas com a borda).
export const COLLAPSED_ROWS = 4
// Quantos passos o card lista; com a borda, o título e a barra dá STATUS_ROWS.
const CARD_STEPS = STATUS_ROWS - 4
// O botão [−]/[+] fica por cima do canto do título (desenhado pelo register).
export const TOGGLE_ROOM = 4
const TICK_MS = 120

// Roxo do cursor "Claude" que aparece na página, pra card e página combinarem.
export const ACCENT = '#a855f7'
// Fundo padrão: quase preto, some na maioria dos temas escuros. Pintar é
// obrigatório: célula sem tinta deixa vazar o texto da conversa por trás do
// painel. Quem usa tema claro troca pela opção `background` do plugin.
export const BG = '#050505'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const ICON: Record<Step['status'], string> = { working: '●', next: '○', done: '✓', failed: '✗' }
// Cores fixas, não as do tema: em alguns temas o "success" sai azul.
const GREEN = '#22c55e'
const RED = '#ef4444'
const ICON_COLOR: Record<Step['status'], string> = {
  working: ACCENT,
  next: 'inactive',
  done: GREEN,
  failed: RED,
}
// O card divide em duas colunas a partir desta largura útil.
const SPLIT_MIN_COLS = 90

export function formatMs(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export type Chapter = { title: string; status: Step['status']; actions: number; checks: number; checksOk: number; ms: number; failedStep: string | null }

// Tempo ativo: soma do que cada passo levou, sem o tempo pensando entre comandos.
export function activeMs(steps: Step[], now: number): number {
  return steps.reduce((sum, step) => sum + (step.ms ?? (step.status === 'working' ? now - step.startedAt : 0)), 0)
}

export function chaptersOf(steps: Step[], titles: string[], now: number): Chapter[] {
  return titles.map((title, i) => {
    const own = steps.filter(step => step.chapter === i)
    const checks = own.filter(step => step.check)
    const status: Step['status'] = own.some(step => step.status === 'failed')
      ? 'failed'
      : own.some(step => step.status === 'working' || step.status === 'next')
        ? 'working'
        : 'done'
    return {
      title,
      status,
      actions: own.length,
      checks: checks.length,
      checksOk: checks.filter(step => step.status === 'done').length,
      ms: activeMs(own, now),
      failedStep: own.find(step => step.status === 'failed')?.label ?? null,
    }
  }).filter(chapter => chapter.actions > 0)
}

// No relatório, falhas primeiro (nunca somem da lista curta), depois as
// etapas mais recentes, na ordem em que aconteceram.
export function reportChapters(chapters: Chapter[], room: number): Chapter[] {
  const failed = chapters.filter(chapter => chapter.status === 'failed')
  const rest = chapters.filter(chapter => chapter.status !== 'failed')
  return [...failed, ...rest.slice(-Math.max(0, room - failed.length))].slice(0, room)
}

function stepRight(step: Step, now: number): string {
  if (step.status === 'working') return `${step.check ? 'verificando' : 'fazendo'} ${formatMs(now - step.startedAt)}`
  if (step.status === 'next') return 'próximo'
  if (step.status === 'failed') return 'falhou'
  if (step.check) return 'passou'
  return step.ms !== null ? formatMs(step.ms) : 'feito'
}

// Barra fina: parte feita em cor, o resto como trilho apagado.
function bar(width: number, fraction: number): [string, string] {
  const w = Math.max(4, width)
  const full = Math.round(w * Math.min(1, Math.max(0, fraction)))
  return ['━'.repeat(full), '─'.repeat(w - full)]
}

const TYPE_SHORT: Record<string, string> = {
  Document: 'doc', Stylesheet: 'css', Script: 'js', XHR: 'xhr', Fetch: 'fetch',
  Image: 'img', Font: 'font', Media: 'media', WebSocket: 'ws', Manifest: 'manif', Other: 'outro',
}

const hostOf = (url: string | null | undefined) => (url ? /^https?:\/\/([^/]+)/.exec(url)?.[1] : undefined)

// O site da página: o do último documento carregado (a URL do estado pode
// estar velha logo depois de um reload).
function pageHost(requests: Req[], pageUrl: string | null): string | undefined {
  const doc = [...requests].reverse().find(r => r.t === 'Document')
  return hostOf(doc?.u) ?? hostOf(pageUrl)
}

// Caminho relativo quando é do mesmo site; senão, host + caminho.
function reqPath(url: string, host: string | undefined): string {
  const m = /^https?:\/\/([^/]+)(\/[^#]*)?/.exec(url)
  if (!m) return url
  const path = m[2] ?? '/'
  return m[1] === host ? path : `${m[1]}${path}`
}

function statusColor(s: number | null): string {
  if (s === null) return ACCENT
  if (s >= 400) return RED
  if (s >= 300) return 'inactive'
  return GREEN
}

// --- linhas de largura exata ---
//
// Cada linha do card é uma fila de pedaços (texto + estilo) cortada e
// completada até a largura certa. Espaço comum no fim de um Text some ao
// desenhar, e célula sem tinta deixa vazar o texto da conversa por trás do
// painel (as "letras soltas"); por isso o preenchimento usa espaço não
// separável, que conta e é pintado.

type Seg = { t: string; color?: string; bold?: boolean; dim?: boolean }

const NBSP = ' '
const segLen = (segs: Seg[]) => segs.reduce((n, s) => n + [...s.t].length, 0)

// Corta os pedaços em `width` células (com … no corte) e completa com espaço.
function fitSegs(segs: Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let room = Math.max(0, width)
  for (const seg of segs) {
    if (room <= 0) break
    const chars = [...seg.t]
    if (chars.length <= room) {
      out.push(seg)
      room -= chars.length
    } else {
      out.push({ ...seg, t: room > 1 ? `${chars.slice(0, room - 1).join('')}…` : chars.slice(0, room).join('') })
      room = 0
    }
  }
  if (room > 0) out.push({ t: ' '.repeat(room) })
  return out
}

// Esquerda à esquerda, direita encostada na borda; a esquerda cede espaço.
function spread(left: Seg[], right: Seg[], width: number): Seg[] {
  const rightW = Math.min(segLen(right), Math.max(0, width - 2))
  return [...fitSegs(left, width - rightW), ...fitSegs(right, rightW)]
}

// Coluna da direita: cabeçalho com o resumo e as requisições mais recentes
// (a última embaixo, como um log). Um erro de console toma a última linha.
function netLines(props: CardProps, width: number, rows: number): Seg[][] {
  const { requests } = props
  const fails = requests.filter(r => r.s !== null && r.s >= 400).length
  const errors = props.console.filter(c => c.type === 'error')
  const apis = requests.filter(r => r.t === 'XHR' || r.t === 'Fetch').length
  const host = pageHost(requests, props.url)
  const head: Seg[] = [{ t: '◉ Rede ', color: ACCENT, bold: true }, { t: `${requests.length} req`, dim: true }]
  if (apis > 0) head.push({ t: ` · ${apis} api`, dim: true })
  if (fails > 0) head.push({ t: ` · ${fails} falha${fails > 1 ? 's' : ''}`, color: RED, bold: true })
  if (errors.length > 0) head.push({ t: ` · ${errors.length} erro${errors.length > 1 ? 's' : ''} console`, color: RED, bold: true })
  const out: Seg[][] = [fitSegs(head, width)]
  const room = rows - 1 - (errors.length > 0 ? 1 : 0)
  if (requests.length === 0) out.push(fitSegs([{ t: 'nenhuma requisição ainda', dim: true }], width))
  for (const r of requests.slice(-room)) {
    const isApi = r.t === 'XHR' || r.t === 'Fetch'
    out.push(fitSegs([
      { t: (r.s === null ? '…' : String(r.s)).padEnd(4), color: statusColor(r.s), bold: true },
      { t: r.m.slice(0, 4).padEnd(5), dim: true },
      { t: (TYPE_SHORT[r.t] ?? r.t.toLowerCase().slice(0, 5)).padEnd(6), color: isApi ? ACCENT : 'inactive' },
      { t: reqPath(r.u, host), bold: isApi },
    ], width))
  }
  const lastError = errors[errors.length - 1]
  if (lastError) out.push(fitSegs([{ t: `✗ console: ${lastError.text.replace(/\s+/g, ' ')}`, color: RED }], width))
  return out
}

// Junta a coluna de passos e a de rede, linha a linha, com um │ no meio.
function joinColumns(left: Seg[][], right: Seg[][], leftW: number, rightW: number, rows: number): Seg[][] {
  return Array.from({ length: rows }, (_, i) => [
    ...fitSegs(left[i] ?? [], leftW),
    { t: ' │ ', dim: true },
    ...fitSegs(right[i] ?? [], rightW),
  ])
}

function stepLine(step: Step, now: number, frame: string, width: number): Seg[] {
  const isCurrent = step.status === 'working'
  const icon = isCurrent ? frame : ICON[step.status]
  const right: Seg = isCurrent
    ? { t: ` ${stepRight(step, now)}`, color: ACCENT }
    : step.check
      ? { t: ` ${stepRight(step, now)}`, color: step.status === 'failed' ? RED : GREEN }
      : { t: ` ${stepRight(step, now)}`, dim: true }
  return spread(
    [{ t: `${icon} ${step.label}`, color: ICON_COLOR[step.status], bold: isCurrent || step.check, dim: step.status === 'next' }],
    [right],
    width,
  )
}

function chapterLine(chapter: Chapter, width: number): Seg[] {
  const parts = [`${chapter.actions}`]
  if (chapter.checks > 0) parts.push(`${chapter.checksOk}/${chapter.checks}✓`)
  parts.push(formatMs(chapter.ms))
  const left: Seg[] = [{ t: `${ICON[chapter.status]} `, color: ICON_COLOR[chapter.status], bold: true }, { t: chapter.title, bold: chapter.status === 'failed' }]
  if (chapter.failedStep) left.push({ t: ` · falhou: ${chapter.failedStep}`, color: RED })
  return spread(left, [{ t: ` ${parts.join(' · ')}`, dim: true }], width)
}

/** A cor da borda e as linhas do card (sem a borda). Puro, pra teste. */
export function cardLines(props: CardProps, now: number): { color: string; lines: Seg[][] } {
  const { steps, finishedAt, intent, chapters: titles } = props
  const inner = Math.max(10, props.cols - 4)
  const where = props.url ? props.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''
  const frame = SPINNER[Math.floor(now / TICK_MS) % SPINNER.length]!
  const split = inner >= SPLIT_MIN_COLS
  const leftW = split ? Math.floor((inner - 3) * 0.5) : inner
  const rightW = split ? inner - 3 - leftW : 0
  const body = (left: Seg[][]): Seg[][] =>
    split ? joinColumns(left, netLines(props, rightW, CARD_STEPS), leftW, rightW, CARD_STEPS) : left

  if (steps.length === 0) {
    return {
      color: 'inactive',
      lines: [
        spread([{ t: '◆ Agente no navegador', color: 'inactive', bold: true }], [{ t: ' parado', dim: true }], inner - TOGGLE_ROOM),
        [{ t: '─'.repeat(inner), dim: true }],
        ...body([
          [{ t: where ? `↳ ${where}` : '', dim: true }],
          [{ t: 'Quando o agente mexer aqui,', dim: true }],
          [{ t: 'cada passo aparece neste card.', dim: true }],
        ]),
      ],
    }
  }

  const isFinished = finishedAt !== null
  const failedCount = steps.filter(step => step.status === 'failed').length
  const done = steps.filter(step => step.status === 'done' || step.status === 'failed').length
  const checks = steps.filter(step => step.check && (step.status === 'done' || step.status === 'failed'))
  const checksOk = checks.filter(step => step.status === 'done').length
  const active = activeMs(steps, now)
  const working = steps.findIndex(step => step.status === 'working')
  const color = isFinished ? (failedCount > 0 ? RED : GREEN) : ACCENT
  const scoreColor = checks.length === checksOk ? GREEN : RED

  if (isFinished) {
    const chapters = chaptersOf(steps, titles, now)
    const head: Seg[] = [
      { t: failedCount > 0 ? '✗ Terminou com falha' : '✓ Concluído', color, bold: true },
      { t: '  ·  ', dim: true },
      { t: `${chapters.length} etapas · ${steps.length} ações` },
    ]
    if (checks.length > 0) head.push({ t: '  ·  ', dim: true }, { t: `${checksOk}/${checks.length} verificações`, color: scoreColor, bold: true })
    const [barDone] = bar(inner - 6, 1)
    return {
      color,
      lines: [
        spread(head, [{ t: ` ${formatMs(active)} ativos`, dim: true }], inner - TOGGLE_ROOM),
        [{ t: barDone, color }, { t: ' 100%', color, bold: true }],
        ...body(reportChapters(chapters, CARD_STEPS).map(chapter => chapterLine(chapter, leftW))),
      ],
    }
  }

  const counter = `${Math.min(done + 1, steps.length)}/${steps.length}  `
  const score = checks.length > 0 ? `  ${checksOk}/${checks.length} ✓` : ''
  const percent = ` ${Math.round((done / steps.length) * 100)}%`
  const [barDone, barRest] = bar(inner - counter.length - percent.length - score.length, done / steps.length)
  const anchor = working >= 0 ? working : steps.length - 1
  const from = Math.max(0, Math.min(anchor - 1, steps.length - CARD_STEPS))
  const barLine: Seg[] = [
    { t: counter, dim: true },
    { t: barDone, color: ACCENT },
    { t: barRest, dim: true },
    { t: percent, bold: true },
  ]
  if (score) barLine.push({ t: score, color: scoreColor, bold: true })
  return {
    color,
    lines: [
      spread([{ t: `${frame} ${intent ?? 'Agente no navegador'}`, color: ACCENT, bold: true }], [{ t: ` ${formatMs(active)}`, dim: true }], inner - TOGGLE_ROOM),
      barLine,
      ...body(steps.slice(from, from + CARD_STEPS).map(step => stepLine(step, now, frame, leftW))),
    ],
  }
}

const isWorking = (props: CardProps | null) =>
  props !== null && props.finishedAt === null && props.steps.some(step => step.status === 'working')

// Um card por painel: as props da última chamada, pro relógio decidir se gira.
let current: CardProps | null = null

const wallNow = () => (typeof Date === 'function' ? Date.now() : 0)

export default function Card(props: CardProps, surface: ClientSurface<{ tick: number }>) {
  const { Box, Text } = surface.elements
  current = props
  if (surface.state === undefined) {
    surface.setState({ tick: 0 })
    // Gira só com um passo rodando; parado, nenhum redesenho.
    surface.every(TICK_MS, () => {
      if (isWorking(current)) surface.setState({ tick: (surface.state?.tick ?? 0) + 1 })
    })
  }
  const now = Math.max(props.now, wallNow())
  const { color, lines } = cardLines(props, now)
  const inner = Math.max(10, props.cols - 4)
  return (
    <Box flexDirection="column" width={props.cols} height={props.rows} backgroundColor={props.background} borderStyle="round" borderColor={color} paddingX={1}>
      {Array.from({ length: props.rows - 2 }, (_, i) => (
        <Box key={`l${i}`} flexDirection="row" height={1} overflow="hidden">
          {fitSegs(lines[i] ?? [], inner).map((s, j) => (
            <Text key={`l${i}-${j}`} color={s.color ?? 'text'} bold={s.bold === true} dimColor={s.dim === true}>
              {s.t.replace(/ /g, NBSP)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
