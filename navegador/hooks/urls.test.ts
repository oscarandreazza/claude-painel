import { expect, test } from 'claude-code/testing'

import { isWorkspacePage } from './urls.ts'

test('VS Code no painel é página de trabalho; o resto é teste', () => {
  expect(isWorkspacePage('http://127.0.0.1:8765/?folder=/tmp', '')).toBe(false)
  expect(isWorkspacePage('http://localhost:3000/', 'demo — Visual Studio Code')).toBe(true)
  expect(isWorkspacePage('http://localhost:3000/', 'Checkout')).toBe(false)
  expect(isWorkspacePage(null, '')).toBe(false)
  expect(isWorkspacePage('nao é url', '')).toBe(false)
})

test('título de VS Code fora da própria máquina não vira página de trabalho', () => {
  expect(isWorkspacePage('http://127.0.0.1:8765/?folder=/tmp', 'app — Visual Studio Code')).toBe(true)
  expect(isWorkspacePage('https://site-qualquer.com/', 'Login — Visual Studio Code')).toBe(false)
  expect(isWorkspacePage('http://localhost.evil.com/', 'x — Visual Studio Code')).toBe(false)
  expect(isWorkspacePage(null, 'x — Visual Studio Code')).toBe(false)
})
