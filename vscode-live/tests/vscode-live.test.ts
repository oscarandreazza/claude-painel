import { expect, test } from 'claude-code/testing'

import { hunksOf } from '../hooks/register.ts'

const HOME = '/Users/teste'
const ROOT = '/Users/teste/projects/elo-cli'
const SESSION = 'sessao-1'
const BRIDGE = `${HOME}/.claude/claude-live/bridge/${SESSION}.json`
const WINDOW = `${HOME}/.claude/claude-live/windows/${encodeURIComponent(ROOT)}.json`
const LIVE = `${HOME}/.claude/claude-live/windows/live-${SESSION}`

type Written = { path: string; text: string }

test('/vscode reaproveita o servidor no ar, abre a pasta e liga a janela à sessão', async ($, on) => {
  const opened: string[] = []
  const writes: Written[] = []
  const started: string[][] = []
  on('command.register', () => ({ value: { command: 'vscode' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('/token')) return { value: 'tok123\n' }
    if (path.endsWith('package.json')) return { value: '{"version":"0.2.0"}' }
    return { value: 'codigo' }
  })
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => {
    writes.push(e as unknown as Written)
    return { value: undefined }
  })
  on('http.fetch', () => ({ value: { status: 403, ok: false, headers: {}, text: '' } }))
  on('process.run', (_, e) => {
    started.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    opened.push(String((e as { url?: string }).url))
    return { result: [{ type: 'text', text: 'opened' }] }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({
    command: 'vscode',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  // Servidor no ar: não sobe outro; a pasta da ponte fica só do usuário.
  expect(started.filter(argv => argv.join(' ').includes('serve-web'))).toEqual([])
  expect(started).toContainEqual(['chmod', '700', `${HOME}/.claude/claude-live`])
  // A pasta direto: o mesmo endereço de sempre, sem pergunta de confiança nova.
  expect(opened).toEqual([`http://127.0.0.1:8765/?tkn=tok123&folder=${encodeURIComponent(ROOT)}`])
  const binding = JSON.parse(writes.find(w => w.path === WINDOW)?.text ?? '{}') as { session: string; sessionFolder: string }
  expect([binding.session, binding.sessionFolder]).toEqual([SESSION, ROOT])
  expect(writes.find(w => w.path === LIVE)?.text).toBe(ROOT)
  expect(JSON.stringify(ran)).toContain('reaproveitei')
})

test('uma edição de subagente vira início e fim na ponte, com sessão, agente e linhas', async ($, on) => {
  const writes: Written[] = []
  on('command.register', () => ({ value: { command: 'vscode' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: SESSION }))
  on('fs.exists', () => ({ value: true }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'revisor', type: 'general-purpose', status: 'running' }] }))
  on('fs.write', (_, e) => {
    writes.push(e as unknown as Written)
    return { value: undefined }
  })
  on('tool.call', () => ({
    result: {
      filePath: `${ROOT}/a.ts`,
      structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [' x', '-y', '+y1', '+y2'] }],
    },
  }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.ts`, old_string: 'y', new_string: 'y1\ny2', agentId: 'a1' })

  const last = writes.filter(w => w.path === BRIDGE).at(-1)
  expect(last).toBeDefined()
  const events = (
    JSON.parse(last?.text ?? '{}') as { events: { type: string; session: string; agent?: string; ranges?: unknown }[] }
  ).events
  expect(events.map(ev => ev.type)).toEqual(['start', 'end'])
  expect(events.map(ev => ev.session)).toEqual([SESSION, SESSION])
  expect(events.map(ev => ev.agent)).toEqual(['revisor', 'revisor'])
  expect(events[1]?.ranges).toEqual([{ start: 4, end: 5 }])
  const end = events[1] as unknown as { adds: number; dels: number }
  expect([end.adds, end.dels]).toEqual([2, 1])
})

test('uma leitura vira read com as linhas lidas, e comando não vai pra ponte', async ($, on) => {
  const writes: Written[] = []
  on('command.register', () => ({ value: { command: 'vscode' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: SESSION }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_, e) => {
    writes.push(e as unknown as Written)
    return { value: undefined }
  })
  on('tool.call', (_, e) =>
    (e as { tool: string }).tool === 'Bash'
      ? { result: { stdout: 'segredo=123\n', stderr: '', interrupted: false } }
      : { result: { type: 'text', file: { filePath: `${ROOT}/a.ts`, content: 'x', numLines: 3, startLine: 10, totalLines: 40 } } },
  )

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'env' })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.ts`, offset: 10, limit: 3 })

  const last = writes.filter(w => w.path === BRIDGE).at(-1)?.text ?? '{}'
  const events = (JSON.parse(last) as { events: { type: string; name?: string; start?: number; end?: number }[] }).events
  expect(events.map(ev => ev.type)).toEqual(['read'])
  expect([events[0]?.start, events[0]?.end]).toEqual([10, 12])
  expect(last).not.toContain('segredo')
  // Sem Elo (elo name falhou), nenhum nome: a extensão mostra "Claude".
  expect(events[0]?.name).toBeUndefined()
})

test('sessão que não abriu o VS Code não grava nada no disco', async ($, on) => {
  const writes: Written[] = []
  on('command.register', () => ({ value: { command: 'vscode' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: SESSION }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_, e) => {
    writes.push(e as unknown as Written)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: { stdout: 'segredo=123\n', stderr: '', interrupted: false } }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'env' })

  expect(writes).toEqual([])
})

test('typecheck que falhou: os erros vêm do texto de erro e viram problemas na ponte', async ($, on) => {
  const writes: Written[] = []
  on('command.register', () => ({ value: { command: 'vscode' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: ROOT }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_, e) => {
    writes.push(e as unknown as Written)
    return { value: undefined }
  })
  const tscOutput = "src/a.ts(5,31): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."
  on('tool.call', () => ({ isError: true, text: `Exit code 2\n${tscOutput}`, result: { stdout: '', stderr: tscOutput, interrupted: false } }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })

  const events = (
    JSON.parse(writes.filter(w => w.path === BRIDGE).at(-1)?.text ?? '{}') as {
      events: { type: string; source?: string; items?: { file: string; line: number; col: number }[] }[]
    }
  ).events
  expect(events.map(ev => [ev.type, ev.source])).toEqual([['diagnostics', 'tsc']])
  // stdout/stderr e o texto de erro trazem o mesmo erro: conta uma vez.
  expect(events[0]?.items?.map(d => [d.file, d.line, d.col])).toEqual([[`${ROOT}/src/a.ts`, 5, 31]])
})

test('o fim da edição leva os trechos alterados (ou "criado"), pro antes do diff', () => {
  const hunk = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, lines: ['-b', '+B1', '+B2'] }
  expect(hunksOf({ structuredPatch: [hunk] })).toEqual({ hunks: [hunk] })
  expect(hunksOf({ type: 'create', content: 'x\n' })).toEqual({ created: true })
  // Edição gigante: sem trechos, a extensão usa o que leu.
  const big = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 3000, lines: Array.from({ length: 3000 }, () => '+x') }
  expect(hunksOf({ structuredPatch: [big] })).toEqual({})
})
