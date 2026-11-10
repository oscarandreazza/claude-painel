import { expect, test } from 'claude-code/testing'

import { commandCwd, parseDiagnostics, sourcesRun } from '../hooks/diagnostics.ts'

const HOME = '/Users/teste'
const CWD = '/Users/teste/projects/app'

test('tsc: os dois formatos, caminho relativo resolvido pela pasta do comando', () => {
  const out = [
    'src/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    '\x1b[96msrc/b.ts\x1b[0m:\x1b[93m3\x1b[0m:\x1b[93m1\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2304: \x1b[0mCannot find name \'x\'.',
    'Found 2 errors.',
  ].join('\n')
  const found = parseDiagnostics('npx tsc --noEmit', out, CWD, HOME)
  expect(found.get('tsc')).toEqual([
    { file: `${CWD}/src/a.ts`, line: 12, col: 5, severity: 'error', code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
    { file: `${CWD}/src/b.ts`, line: 3, col: 1, severity: 'error', code: 'TS2304', message: "Cannot find name 'x'." },
  ])
})

test('eslint stylish: arquivo no cabeçalho, problemas embaixo, aviso e regra', () => {
  const out = [
    '',
    `${CWD}/src/a.ts`,
    '  4:10  error    \'y\' is assigned a value but never used  @typescript-eslint/no-unused-vars',
    '  9:1   warning  Unexpected console statement            no-console',
    '',
    '✖ 2 problems (1 error, 1 warning)',
  ].join('\n')
  const items = parseDiagnostics('npm run lint', out, CWD, HOME).get('eslint') ?? []
  expect(items.map(d => [d.line, d.col, d.severity, d.code])).toEqual([
    [4, 10, 'error', '@typescript-eslint/no-unused-vars'],
    [9, 1, 'warning', 'no-console'],
  ])
  expect(items[0]?.file).toBe(`${CWD}/src/a.ts`)
})

test('vitest: o teste que falhou vira problema na linha do erro', () => {
  const out = [
    ' FAIL  tests/carrinho.test.ts > total > aplica o cupom',
    'AssertionError: expected 33 to be 29.7 // Object.is equality',
    '',
    ' ❯ tests/carrinho.test.ts:14:22',
  ].join('\n')
  const items = parseDiagnostics('npx vitest run', out, CWD, HOME).get('testes') ?? []
  expect(items).toHaveLength(1)
  expect(items[0]?.file).toBe(`${CWD}/tests/carrinho.test.ts`)
  expect([items[0]?.line, items[0]?.col]).toEqual([14, 22])
  expect(items[0]?.message).toContain('aplica o cupom')
})

test('ferramenta que rodou limpa volta com lista vazia; comando qualquer não apaga nada', () => {
  expect(parseDiagnostics('npm run typecheck', 'tudo certo', CWD, HOME).get('tsc')).toEqual([])
  expect(parseDiagnostics('npm run build', 'tudo certo', CWD, HOME).size).toBe(0)
  expect([...sourcesRun('pnpm test && npx eslint .')].sort()).toEqual(['eslint', 'testes'])
})

test('a pasta do comando segue o último cd', () => {
  expect(commandCwd('cd web && npx tsc', CWD, HOME)).toBe(`${CWD}/web`)
  expect(commandCwd('cd ~/projects/outro && npm test', CWD, HOME)).toBe(`${HOME}/projects/outro`)
  expect(commandCwd('npx tsc', CWD, HOME)).toBe(CWD)
})
