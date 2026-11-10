import { expect, test } from 'claude-code/testing'
import { formatMs, parseBrowserSteps, parseEvents, relabel, tokenize } from './activity.ts'

const step = (label: string, check = false) => ({ kind: 'step', label, check })

test('lê os passos de um comando com várias ações encadeadas', () => {
  const steps = parseBrowserSteps(
    'terminal-browser action -- open https://news.ycombinator.com/ && terminal-browser action -- click @e104; terminal-browser action -- fill @e3 "oi mundo" | tail -1',
  )
  expect(steps).toEqual([step('abrir news.ycombinator.com'), step('clicar'), step('digitar “oi mundo”')])
})

test('action done encerra, e comando sem terminal-browser não gera passo', () => {
  expect(parseBrowserSteps('terminal-browser action done 2>&1')).toEqual([{ kind: 'done' }])
  expect(parseBrowserSteps('ls -la && git status')).toEqual([])
})

test('seletores antes do -- e open/new-tab do CLI', () => {
  expect(parseBrowserSteps('terminal-browser action --tab 2 -- snapshot -i')).toEqual([step('ler a página')])
  expect(parseBrowserSteps('terminal-browser open localhost:3000 --split right')).toEqual([
    step('abrir o navegador localhost:3000'),
  ])
})

test('wait com condição e is viram verificação; wait em ms é pausa', () => {
  expect(
    parseBrowserSteps(
      `terminal-browser action -- wait --text "2 items left"; terminal-browser action -- is checked @e5; terminal-browser action -- wait 500; terminal-browser action -- wait --url "**/todomvc/#/active"`,
    ),
  ).toEqual([
    step('verificar texto “2 items left”', true),
    step('verificar marcado: @e5', true),
    step('esperar 500ms'),
    step('verificar URL **/todomvc/#/active', true),
  ])
})

test('eventos do wrapper: ignora linha quebrada', () => {
  expect(parseEvents('{"cmd":"click","ok":true,"out":"✓ Done"}\nlixo\n{"cmd":"is","ok":false,"out":"false"}\n')).toEqual([
    { cmd: "click", ok: true, out: "✓ Done", target: "", phase: "end", label: "", check: false },
    { cmd: "is", ok: false, out: "false", target: "", phase: "end", label: "", check: false },
  ])
})

test('tokenize respeita aspas e formatMs escala', () => {
  expect(tokenize(`fill @e3 "a b" 'c'`)).toEqual(['fill', '@e3', 'a b', 'c'])
  expect(formatMs(420)).toBe('0.4s')
  expect(formatMs(15_000)).toBe('15s')
  expect(formatMs(65_000)).toBe('1m05s')
})

test('relabel troca o seletor pelo nome do elemento', () => {
  expect(relabel('clicar @e12', 'Active')).toBe('clicar “Active”')
  expect(relabel('marcar .todo-list li:first-child input', '  Revisar PR\n do checkout ')).toBe('marcar “Revisar PR do checkout”')
  expect(relabel('ler a página', 'qualquer')).toBe('ler a página')
  expect(relabel('clicar @e12', '')).toBe('clicar @e12')
})

test('rótulo só com o verbo ganha o nome do alvo', () => {
  expect(relabel('clicar', 'Active')).toBe('clicar “Active”')
  expect(relabel('ler a página', 'x')).toBe('ler a página')
})

test('só conta o CLI como comando, não citado em texto', () => {
  const cli = 'terminal-browser'
  expect(parseBrowserSteps(`echo ${cli} action -- click @e1`)).toEqual([])
  expect(parseBrowserSteps(`grep -n "${cli} action" x.ts`)).toEqual([])
  expect(parseBrowserSteps(`python3 - <<'EOF'\nprint("${cli} action -- click @e1")\nEOF\necho ok`)).toEqual([])
  expect(parseBrowserSteps(`FOO=1 env BAR=2 ${cli} action -- click @e1`)).toEqual([step('clicar')])
  expect(parseBrowserSteps(`/opt/bin/${cli} action --browser 1-1 -- press Enter`)).toEqual([step('tecla Enter')])
})

test('tb-run vira roteiro (passos pelos eventos), inclusive com heredoc', () => {
  expect(parseBrowserSteps('tb-run fluxo.mjs')).toEqual([{ kind: 'script' }])
  expect(parseBrowserSteps("tb-run - <<'EOF'\nawait step('x', () => page.click('a'))\nEOF")).toEqual([{ kind: 'script' }])
  expect(parseBrowserSteps('tb-run --help')).toEqual([])
  expect(parseBrowserSteps('echo tb-run fluxo.mjs')).toEqual([])
})

test('evento add do tb-run traz rótulo e se é verificação', () => {
  const [add, end] = parseEvents('{"cmd":"check","ok":true,"out":"","target":"","phase":"add","label":"ver “Oi”","check":true}\n{"cmd":"check","ok":false,"out":"x","target":""}\n')
  expect(add).toEqual({ cmd: 'check', ok: true, out: '', target: '', phase: 'add', label: 'ver “Oi”', check: true })
  expect(end?.phase).toBe('end')
  expect(end?.check).toBe(false)
})

test('tb-look vira passo de leitura, com o escopo quando tem', () => {
  expect(parseBrowserSteps('tb-look')).toEqual([step('ler a página')])
  expect(parseBrowserSteps("tb-look 'role=dialog' --linhas 30")).toEqual([step('ler a página: role=dialog')])
  expect(parseBrowserSteps('tb-look --browser 3058-1 form')).toEqual([step('ler a página: form')])
})

test('evento chapter do tb-run abre etapa com título', () => {
  const [ev] = parseEvents('{"cmd":"chapter","ok":true,"out":"","target":"","phase":"chapter","label":"02-api.mjs"}\n')
  expect(ev?.phase).toBe('chapter')
  expect(ev?.label).toBe('02-api.mjs')
})

test('evento rec do tb-run --video liga e desliga a gravação', () => {
  const [on, off] = parseEvents('{"cmd":"rec","ok":true,"out":"","target":"","phase":"rec","label":"on"}\n{"cmd":"rec","ok":true,"out":"","target":"","phase":"rec","label":"off"}\n')
  expect(on?.phase).toBe('rec')
  expect(on?.label).toBe('on')
  expect(off?.label).toBe('off')
})
