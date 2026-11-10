import { expect, test } from 'claude-code/testing'
import { cardLines, STATUS_ROWS, TOGGLE_ROOM, type CardProps } from './card.tsx'
import type { Step } from './activity.ts'

const base = (over: Partial<CardProps> = {}): CardProps => ({
  cols: 60,
  background: '#050505',
  rows: STATUS_ROWS,
  collapsed: false,
  now: 10_000,
  url: 'https://example.com/',
  steps: [],
  finishedAt: null,
  intent: null,
  chapters: [],
  requests: [],
  console: [],
  ...over,
})

const step = (over: Partial<Step>): Step => ({
  label: 'clicar', status: 'done', startedAt: 0, ms: 500, check: false, chapter: 0, ...over,
})

const text = (segs: { t: string }[]) => segs.map(s => s.t).join('')

test('parado: card cinza e a primeira linha deixa o canto do botão livre', () => {
  const { color, lines } = cardLines(base(), 10_000)
  expect(color).toBe('inactive')
  const inner = 60 - 4
  expect([...text(lines[0]!)].length).toBe(inner - TOGGLE_ROOM)
  expect(text(lines[2]!)).toContain('example.com')
})

test('rodando: o spinner anda com o relógio e o tempo do passo cresce', () => {
  const props = base({
    intent: 'Marcar tarefas',
    chapters: ['Marcar tarefas'],
    steps: [step({ status: 'done' }), step({ label: 'digitar', status: 'working', startedAt: 9_000, ms: null })],
  })
  const a = cardLines(props, 10_000)
  const b = cardLines(props, 10_120)
  expect(a.color).not.toBe('inactive')
  expect(text(a.lines[0]!)).toContain('Marcar tarefas')
  expect(text(a.lines[0]!)).not.toBe(text(b.lines[0]!))
  const working = a.lines.map(text).find(line => line.includes('digitar'))
  expect(working).toContain('fazendo 1.0s')
})

test('fim: relatório com etapas e placar das verificações', () => {
  const props = base({
    cols: 140,
    finishedAt: 20_000,
    chapters: ['Abrir', 'Conferir'],
    steps: [step({ chapter: 0 }), step({ chapter: 1, check: true, label: 'verificar texto' })],
  })
  const { lines } = cardLines(props, 20_000)
  const head = text(lines[0]!)
  expect(head).toContain('Concluído')
  expect(head).toContain('2 etapas')
  expect(head).toContain('1/1 verificações')
})
