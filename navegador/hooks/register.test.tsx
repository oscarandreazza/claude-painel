import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Testes do fluxo do painel (register.tsx) contra uma ponte falsa do
// terminal-browser. Cada um guarda um bug que já aconteceu:
// - o pisca: redesenho mandando de novo um quadro que o blit já entregou;
// - a tela preta depois de um /reload-plugins com o painel aberto;
// - o comando Bash do agente reescrito (o auto mode recusava a chamada).

const PORT = 4555
const TOKEN = 'tk'
const KEY = '9-1'
const URL_PAGE = 'http://127.0.0.1:5577/'

type FakeFrame = { shm: string; format: 'rgb'; width: number; height: number; generation: number; cols: number; rows: number }

const frame = (n: number, cols = 80, rows = 20): FakeFrame => ({
  shm: `/tb-${n}`, format: 'rgb', width: cols * 8, height: rows * 16, generation: n, cols, rows,
})

const PANE = (bodyRows = 30) => ({
  plugin: 'navegador',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'browser',
  props: {
    title: 'navegador',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  },
})

// O mundo debaixo do plugin: relógio, HOME, processos, a ponte por HTTP e as
// chamadas de interface. Tudo o que o plugin manda fica em `calls`.
function world(on: On, opts: { saved?: { port: number; token: string; chromeless?: boolean } } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/t' })
  const calls = {
    posts: [] as { path: string; body: Record<string, unknown> }[],
    blits: [] as string[],
    bash: [] as string[],
  }
  let bridge = { version: 1, frame: null as FakeFrame | null, title: 'Teste', url: URL_PAGE, alive: true, error: null, inbox: 0 }
  const bump = (patch: Partial<typeof bridge>) => {
    bridge = { ...bridge, ...patch, version: bridge.version + 1 }
  }

  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({
      value: { stdout, stderr: '', exitCode, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv.endsWith(' capabilities')) return out(JSON.stringify({ capabilities: ['embedding', 'image-frames'] }))
    if (argv.includes('claude-bridge launch')) return out(JSON.stringify({ port: PORT, token: TOKEN }))
    if (argv.startsWith('sh -c p=$PPID')) return out('ttys009\n')
    if (argv.includes(' ls --all --json')) return out(JSON.stringify({ browsers: [{ key: KEY, tty: '/dev/ttys009' }] }))
    if (argv.includes('tb-net')) return out('{"requests":[],"console":[]}')
    return out('')
  })
  // A ponte: /state segura a resposta até a versão mudar (como o long-poll de
  // 1 s da real, no relógio do teste); o resto só é registrado.
  on('http.fetch', async (_$, e) => {
    const u = new URL(e.url)
    const reply = (body: unknown) => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } })
    if (u.pathname === '/state') {
      const since = Number(u.searchParams.get('version'))
      if (bridge.version <= since) await clock.sleep(1000)
      return reply(bridge)
    }
    calls.posts.push({ path: u.pathname, body: JSON.parse(String(e.init?.body ?? '{}')) as Record<string, unknown> })
    return reply(u.pathname === '/inbox/take' ? { items: [] } : bridge)
  })
  on('ui.blit', (_$, e) => {
    if ('source' in e && e.source && 'shm' in e.source) calls.blits.push(e.source.shm)
    return { value: {} }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'browser', title: 'navegador', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('command.register', () => ({ value: { command: 'browser' } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // O Bash de verdade: registra o comando exatamente como chegou.
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') calls.bash.push((e as { command: string }).command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } as never }
  })
  if (opts.saved) {
    on('state.get', () => ({ value: { value: opts.saved, version: 1 } }))
  }
  return { clock, calls, bump, bridge: () => bridge }
}

// O <Image> do desenho atual, com o shm que ele carrega.
async function drawnShm(ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) {
  const [image] = await ui.findAll({ type: 'Image' })
  const source = image?.props.source as { shm?: string } | undefined
  return source?.shm ?? null
}

test('redesenhar o painel não reenvia o quadro que o blit já entregou (o pisca)', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__navegador__open', url: URL_PAGE } as never)
  const ui = await $.ui.mount(PANE())
  // A superfície do painel manda o tamanho; com ele a página é aberta.
  await ui.post({ type: 'size', cols: 80, rows: 20 }, { in: 'view1' })
  expect(w.calls.posts.some(p => p.path === '/open' && p.body.url === URL_PAGE)).toBe(true)

  // Primeiro quadro: vai no desenho.
  w.bump({ frame: frame(1) })
  await w.clock.advance(1000)
  expect(await drawnShm(ui)).toBe('/tb-1')

  // Quadros seguintes: por blit. Entre um blit e outro o plugin segura ~33 ms
  // (teto de ~30 quadros/s), por isso o relógio anda um pouco além do segundo.
  for (const n of [2, 3]) {
    w.bump({ frame: frame(n) })
    await w.clock.advance(1100)
  }
  expect(w.calls.blits).toEqual(['/tb-2', '/tb-3'])

  // O card redesenha o painel: a figura continua a do desenho anterior, sem
  // mandar de novo um shm que o terminal já apagou.
  await ui.redraw()
  expect(await drawnShm(ui)).toBe('/tb-1')
  await ui.unmount()
})

test('depois de um reload com o painel aberto, ele reencontra a ponte e pede quadro novo', async ($, on) => {
  const w = world(on, { saved: { port: PORT, token: TOKEN } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Sem open: o módulo novo só vê o painel sendo desenhado.
  const ui = await $.ui.mount(PANE())
  await w.clock.settle()
  // Remontou a superfície; o tamanho dela vai por /open sem url (a ponte
  // reenvia tamanho e "visível" e manda um quadro, mesmo em página parada).
  await ui.post({ type: 'size', cols: 80, rows: 20 }, { in: 'view1' })
  const open = w.calls.posts.find(p => p.path === '/open')
  expect(open?.body).toEqual({ cols: 80, rows: 20 })

  w.bump({ frame: frame(7) })
  await w.clock.advance(1000)
  expect(await drawnShm(ui)).toBe('/tb-7')
  await ui.unmount()
})

test('o comando Bash do agente chega ao shell como foi escrito', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const command = 'terminal-browser action -- click @e1 && terminal-browser action done'
  await $.tool.call({ tool: 'Bash', command, description: 'Clicar no botão' } as never)
  expect(w.calls.bash).toEqual([command])
})
