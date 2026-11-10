import { expect, test } from 'claude-code/testing'

import { searchHits, shellReads, shellSearch } from '../hooks/reading.ts'

const HOME = '/Users/teste'
const CWD = '/Users/teste/app'

test('sed -n, head e cat viram leituras com as linhas, mesmo encadeados', () => {
  expect(shellReads("sed -n '10,40p' src/a.ts", CWD, HOME)).toEqual([{ file: `${CWD}/src/a.ts`, start: 10, end: 40 }])
  expect(shellReads('head -n 50 README.md', CWD, HOME)).toEqual([{ file: `${CWD}/README.md`, start: 1, end: 50 }])
  expect(shellReads('head -20 b.ts', CWD, HOME)).toEqual([{ file: `${CWD}/b.ts`, start: 1, end: 20 }])
  expect(shellReads('cd web && cat ~/x.json | jq .', CWD, HOME)).toEqual([{ file: `${HOME}/x.json`, start: 1, end: 100_000 }])
  expect(shellReads('npm test', CWD, HOME)).toEqual([])
})

test('awk com NR vira leitura do intervalo de linhas', () => {
  expect(shellReads("awk 'NR>=10 && NR<=40' src/a.ts", CWD, HOME)).toEqual([{ file: `${CWD}/src/a.ts`, start: 10, end: 40 }])
  expect(shellReads("awk 'NR==7' src/a.ts", CWD, HOME)).toEqual([{ file: `${CWD}/src/a.ts`, start: 7, end: 7 }])
  // awk sem NR (filtro de texto) não é leitura de trecho.
  expect(shellReads("awk '/erro/' log.txt", CWD, HOME)).toEqual([])
})

test('rg, grep e git grep: o padrão, com ou sem -e', () => {
  expect(shellSearch("rg -n 'emReais' src")).toBe('emReais')
  expect(shellSearch('grep -rn -e "TODO" .')).toBe('TODO')
  expect(shellSearch('git grep -l useCase')).toBe('useCase')
  expect(shellSearch('ls -la')).toBeUndefined()
})

test('arquivos achados na saída da busca, sem repetir', () => {
  const out = ['src/a.ts:12:  const x = emReais(1)', 'src/a.ts:30:  emReais(2)', 'src/b.ts:4:import { emReais }', '', '3 matches'].join('\n')
  expect(searchHits(out, CWD, HOME)).toEqual([
    { file: `${CWD}/src/a.ts`, line: 12 },
    { file: `${CWD}/src/b.ts`, line: 4 },
  ])
  expect(searchHits('src/c.ts\nsrc/d.tsx', CWD, HOME).map(h => h.file)).toEqual([`${CWD}/src/c.ts`, `${CWD}/src/d.tsx`])
})
