import { expect, test } from 'claude-code/testing'
import { chromeSwitch, chromeWatch, COOLDOWN_MS, STABLE_MS } from './chrome.ts'

const VS = 'http://127.0.0.1:8765/?folder=/x'
const PAGE = 'https://pt.wikipedia.org/wiki/Gato'

test('VS Code estável tira a barra; página comum não mexe', () => {
  const w = chromeWatch()
  expect(chromeSwitch(w, false, 'Wikipédia', PAGE, false, 0)).toBe(null)
  expect(chromeSwitch(w, false, 'Wikipédia', PAGE, false, 5000)).toBe(null)
  expect(chromeSwitch(w, true, 'demo — Visual Studio Code', VS, false, 6000)).toBe(null)
  expect(chromeSwitch(w, true, 'demo — Visual Studio Code', VS, false, 6000 + STABLE_MS - 1)).toBe(null)
  expect(chromeSwitch(w, true, 'demo — Visual Studio Code', VS, false, 6000 + STABLE_MS)).toBe(true)
})

test('título provisório durante a carga não causa vaivém', () => {
  const w = chromeWatch()
  chromeSwitch(w, true, 'VS', VS, true, 0)
  // Recarregando sem barra: título vazio e depois um provisório por 1 s.
  expect(chromeSwitch(w, false, '', VS, true, 1000)).toBe(null)
  expect(chromeSwitch(w, false, '127.0.0.1:8765', VS, true, 1200)).toBe(null)
  expect(chromeSwitch(w, false, '127.0.0.1:8765', VS, true, 2100)).toBe(null)
  expect(chromeSwitch(w, true, 'demo — Visual Studio Code', VS, true, 2200)).toBe(null)
  expect(chromeSwitch(w, true, 'demo — Visual Studio Code', VS, true, 9000)).toBe(null)
})

test('sair do VS Code devolve a barra, e não troca de novo logo em seguida', () => {
  const w = chromeWatch()
  chromeSwitch(w, false, 'Teste', PAGE, true, 0)
  expect(chromeSwitch(w, false, 'Teste', PAGE, true, STABLE_MS)).toBe(false)
  // Mesmo que algo volte a pedir troca, espera o resfriamento.
  chromeSwitch(w, true, 'x — Visual Studio Code', VS, false, STABLE_MS + 10)
  expect(chromeSwitch(w, true, 'x — Visual Studio Code', VS, false, STABLE_MS + 10 + STABLE_MS)).toBe(null)
  expect(chromeSwitch(w, true, 'x — Visual Studio Code', VS, false, STABLE_MS + COOLDOWN_MS)).toBe(true)
})

test('VS Code recarregando com título provisório longo não devolve a barra', () => {
  const w = chromeWatch()
  chromeSwitch(w, true, 'x — Visual Studio Code', VS, false, 0)
  expect(chromeSwitch(w, true, 'x — Visual Studio Code', VS, false, STABLE_MS)).toBe(true)
  // Reaberto sem barra: 10 s de título provisório no mesmo site.
  for (let ms = STABLE_MS + 100; ms < STABLE_MS + 10_000; ms += 500) {
    expect(chromeSwitch(w, false, '127.0.0.1:8765', VS, true, ms)).toBe(null)
  }
  // Foi pra outro site: a barra volta.
  chromeSwitch(w, false, 'Gato', PAGE, true, 20_000)
  expect(chromeSwitch(w, false, 'Gato', PAGE, true, 20_000 + STABLE_MS)).toBe(false)
})
