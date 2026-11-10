// Partes comuns do tb-run e do tb-look: achar o navegador do painel, conectar
// por CDP na aba certa, gravar eventos pro card e desenhar na página.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(here, '..', 'assets')

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// Mensagem do Playwright sem o "Call log" comprido.
export function shortError(err) {
  const msg = String(err?.message ?? err).split('\n')
  const cut = msg.findIndex(l => /^\s*(Call log|=+ logs =+)/i.test(l))
  return clip(msg.slice(0, cut > 0 ? cut : 4).join(' ').replace(/\s+/g, ' ').trim(), 400)
}

// Troca um marcador ($DATA, $B…) sem os padrões especiais do replace ($&, $1).
export const fillIn = (tpl, mark, value) => tpl.replace(mark, () => value)

export function asset(name) {
  try { return fs.readFileSync(path.join(ASSETS, name), 'utf8') } catch { return null }
}

// --- qual navegador e qual aba ---

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

// O tty desta sessão: sobe pelos pais até o primeiro com terminal (igual ao
// plugin, que guarda o navegador de cada sessão pelo tty).
function sessionTty() {
  let pid = process.ppid
  for (let i = 0; i < 10 && pid > 1; i++) {
    try {
      const tty = sh('ps', ['-o', 'tty=', '-p', String(pid)]).trim()
      if (tty && !tty.includes('?')) return tty
      pid = Number(sh('ps', ['-o', 'ppid=', '-p', String(pid)]).trim())
    } catch {
      return null
    }
  }
  return null
}

function pickBrowser(wanted) {
  let listed
  try {
    listed = JSON.parse(sh('terminal-browser', ['ls', '--all', '--json']))
  } catch {
    throw new Error('não consegui listar os navegadores (terminal-browser ls). O painel está aberto? Abra com mcp__navegador__open.')
  }
  const all = listed.browsers ?? []
  if (all.length === 0) throw new Error('nenhum navegador aberto. Abra o painel com mcp__navegador__open primeiro.')
  if (wanted) {
    const found = all.find(b => b.key === wanted)
    if (!found) throw new Error(`navegador ${wanted} não existe. Abertos: ${all.map(b => b.key).join(', ')}`)
    return found
  }
  const tty = sessionTty()
  const mine = tty && all.find(b => b.tty === `/dev/${tty}` || b.tty === tty)
  if (mine) return mine
  const inTab = all.filter(b => b.inCurrentTab)
  if (inTab.length === 1) return inTab[0]
  if (all.length === 1) return all[0]
  throw new Error(`mais de um navegador aberto (${all.map(b => b.key).join(', ')}): passe --browser <chave>, a que o mcp__navegador__open devolveu.`)
}

async function targetIdOf(page) {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { targetInfo } = await cdp.send('Target.getTargetInfo')
    return targetInfo.targetId
  } finally {
    await cdp.detach().catch(() => {})
  }
}

async function findPage(browser, tab) {
  const pages = browser.contexts().flatMap(c => c.pages())
  for (const page of pages) {
    try {
      if ((await targetIdOf(page)) === tab.targetId) return page
    } catch {}
  }
  // Sem targetId batendo (versão do terminal-browser que não informa): pela URL.
  const sameUrl = pages.filter(p => p.url() === tab.url)
  if (sameUrl.length === 1) return sameUrl[0]
  throw new Error(`não achei a aba ${tab.id} (${tab.url}) entre as ${pages.length} páginas do CDP.`)
}

/** Conecta na aba ativa do navegador do painel. Nunca feche o browser: é o da pessoa. */
export async function connect(wantedKey) {
  const tb = pickBrowser(wantedKey)
  if (tb.cdpPort == null) throw new Error(`o navegador ${tb.key} não tem porta de depuração (CDP).`)
  const tab = tb.tabs.find(t => t.active) ?? tb.tabs[0]
  if (!tab) throw new Error(`o navegador ${tb.key} não tem aba aberta.`)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${tb.cdpPort}`)
  const page = await findPage(browser, tab)
  const dir = /^[\w.-]+$/.test(tb.key) ? path.join(os.homedir(), '.tbab', tb.key) : path.join(os.homedir(), '.tbab')
  fs.mkdirSync(dir, { recursive: true })
  return { key: tb.key, browser, page, dir, viewport: tb.viewport ?? null }
}

// --- card ---

export function eventsWriter(dir) {
  const file = path.join(dir, 'events.jsonl')
  return ev => { try { fs.appendFileSync(file, `${JSON.stringify(ev)}\n`) } catch {} }
}

// --- desenho na página ---

// Legenda, cursor, selos e tela final do plugin não são da página: fora da
// árvore de acessibilidade (o texto deles já mora em shadow root fechado).
export async function hideOverlays(page) {
  await page.evaluate(() => document.querySelectorAll('[id^="__ag_"], [class^="__ag_"]').forEach(el => el.setAttribute('aria-hidden', 'true'))).catch(() => {})
}

export async function removeEndcard(page) {
  await page.evaluate(() => document.getElementById('__ag_end')?.remove()).catch(() => {})
}

/** Cursor, contorno e selo no alvo (assets/feedback.js), como no modo action. */
export function highlighter(page) {
  const tpl = asset('feedback.js')
  return async (locator, verb, ripple) => {
    if (!tpl) return
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2_000 })
      const b = await locator.boundingBox({ timeout: 2_000 })
      if (!b) return
      let js = fillIn(tpl, '$B', JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, p: false }))
      js = fillIn(js, '$V', JSON.stringify(verb))
      js = fillIn(js, '$R', ripple ? '1' : '0')
      await page.evaluate(js)
      await sleep(350) // o cursor leva ~0,45 s pra chegar
    } catch {}
  }
}

/** Árvore de acessibilidade em linhas, sem o que o plugin desenhou. Escopo: seletor ou localizador. */
export async function ariaLines(page, scope = 'body') {
  await hideOverlays(page)
  const loc = typeof scope === 'string' ? page.locator(scope) : scope
  const count = await loc.count().catch(() => 0)
  if (count === 0) return { count: 0, lines: [] }
  const text = await loc.first().ariaSnapshot({ timeout: 5_000 }).catch(() => '')
  return { count, lines: text ? text.split('\n') : [] }
}

// Papéis que dizem onde clicar/digitar, mais títulos e regiões pra se situar.
const USEFUL = /^\s*- (button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|tab|tablist|menuitem|menu|switch|slider|spinbutton|heading|dialog|alertdialog|alert|navigation|form|main|banner|table|row|columnheader|img|status|progressbar)\b/

const CONTAINER = /^\s*- (listitem|row|cell)\b/
const TEXT = /^\s*- text: /
const indentOf = l => l.length - l.trimStart().length

const NAMED_ROW = /^\s*- row "/

// Fica o útil, mais o texto logo depois de um controle no mesmo nível (é ele
// que diz qual dos "Toggle Todo" é o de cada linha). Linha de tabela com nome
// já traz o texto das células: as células dela saem.
export function compactAria(lines) {
  const out = []
  let lastKept = null
  let skipDeeper = null
  for (const l of lines) {
    if (skipDeeper !== null) {
      if (indentOf(l) > skipDeeper) continue
      skipDeeper = null
    }
    if (NAMED_ROW.test(l)) {
      out.push(clip(l, indentOf(l) + 160))
      skipDeeper = indentOf(l)
      lastKept = null
    } else if (USEFUL.test(l) || CONTAINER.test(l)) {
      out.push(l)
      lastKept = USEFUL.test(l) ? indentOf(l) : null
    } else if (TEXT.test(l) && lastKept === indentOf(l)) {
      out.push(clip(l, indentOf(l) + 70))
      lastKept = null
    } else {
      lastKept = null
    }
  }
  return out
}

/** A seção de um título: o section/article/form/dialog/main mais próximo, ou o pai do título. */
export async function sectionOf(page, title) {
  const heading = page.getByRole('heading', { name: title }).first()
  if ((await heading.count()) === 0) return null
  const box = heading.locator('xpath=ancestor::*[self::section or self::article or self::form or self::dialog or self::aside or self::main or @role="dialog" or @role="region"][1]')
  return (await box.count()) > 0 ? box : heading.locator('xpath=..')
}

// --- prints sem a sobreposição do plugin ---

export const OVERLAY_CSS = '[id^="__ag_"],[class^="__ag_"]{display:none!important}'

// --- tamanho de tela ---

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** Emula celular ou um tamanho de tela; devolve a função que desfaz (sempre chamar). */
// size: [largura, altura] ou [largura, null] (altura = a do painel).
// O painel mostra a página em tamanho real: tela mais larga que ele sai
// cortada à direita (no painel e no vídeo). Reduzir só a imagem (scale do
// CDP) desalinha o clique, e a densidade de pixel não muda o desenho; o único
// zoom que resolve é o do navegador (Cmd − no painel), que o CDP não alcança.
export async function emulate(page, { mobile = false, size = null, panel = null } = {}) {
  if (!mobile && !size) return { undo: async () => {}, label: null, cropped: false }
  const cdp = await page.context().newCDPSession(page)
  let [width, height] = size ?? [390, 844]
  if (!height) height = panel?.height ?? 800
  const cropped = Boolean(panel && (width > panel.width || height > panel.height))
  const originalUa = await page.evaluate(() => navigator.userAgent)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile })
  if (mobile) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA })
  }
  const label = `${mobile ? 'celular ' : ''}${width}x${height}`
  const undo = async () => {
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    if (mobile) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {})
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: originalUa }).catch(() => {})
    }
    await cdp.detach().catch(() => {})
  }
  return { undo, label, cropped }
}

// --- estado limpo ---

/** Apaga localStorage, sessionStorage, IndexedDB e cookies da origem da página e recarrega. */
export async function cleanOrigin(page) {
  const url = page.url()
  if (!/^https?:/.test(url)) return null
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    const dbs = (await indexedDB.databases?.()) ?? []
    await Promise.all(dbs.map(d => new Promise(r => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => r() })))
  }).catch(() => {})
  const context = page.context()
  const cookies = await context.cookies(url)
  for (const c of cookies) await context.clearCookies({ name: c.name, domain: c.domain, path: c.path }).catch(() => {})
  await page.reload()
  return new URL(url).origin
}

/**
 * Print direto pelo CDP. O page.screenshot do Playwright, depois de uma
 * navegação, desfaz a emulação de tela (--tela/--celular) no meio do roteiro.
 */
export async function shot(page, file, { jpeg = false, hideOverlays = false } = {}) {
  const cdp = await page.context().newCDPSession(page)
  try {
    if (hideOverlays) {
      await page.evaluate(css => {
        const s = document.createElement('style'); s.id = '__ag_shot_css'; s.textContent = css; document.documentElement.appendChild(s)
      }, OVERLAY_CSS).catch(() => {})
    }
    const { data } = await cdp.send('Page.captureScreenshot', jpeg ? { format: 'jpeg', quality: 60 } : { format: 'png' })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return true
  } catch {
    return false
  } finally {
    if (hideOverlays) await page.evaluate(() => document.getElementById('__ag_shot_css')?.remove()).catch(() => {})
    await cdp.detach().catch(() => {})
  }
}
