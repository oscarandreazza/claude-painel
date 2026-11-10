// Evidência da execução do tb-run: vídeo do painel (screencast do CDP +
// ffmpeg) e relatório HTML com passos, prints, rede e erros. O relatório já
// sai no formato de página do claude.ai (sem doctype/head/body, cores por
// token nos dois temas, gutter seguro): dá pra abrir local ou publicar como
// link com a ferramenta Artifact, passando passos/, video.mp4 e falha.png em files.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// --- vídeo ---

// Selo "● REC" com cronômetro no canto superior esquerdo (o único que nunca sai cortado) enquanto grava: quem assiste
// no painel sabe que está gravando, e o vídeo mostra o mesmo. Shadow root
// fechado (o getByText dos roteiros não acha) e id __ag_ (fica fora dos prints de falha).
const REC_BADGE = `(started => {
  if (document.getElementById('__ag_recbadge')) return
  const host = document.createElement('div')
  host.id = '__ag_recbadge'
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, { position: 'fixed', top: '12px', left: '12px', zIndex: 2147483647, pointerEvents: 'none' })
  const ui = host.attachShadow({ mode: 'closed' })
  ui.innerHTML = '<style>.b{display:flex;align-items:center;gap:8px;padding:6px 12px 6px 10px;border-radius:999px;background:rgba(15,10,12,.88);border:1px solid rgba(239,68,68,.6);color:#fff;font:600 13px/1 ui-sans-serif,-apple-system,system-ui;font-variant-numeric:tabular-nums;box-shadow:0 6px 18px rgba(0,0,0,.35)}.d{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:p 1s steps(2,start) infinite}@keyframes p{to{visibility:hidden}}@media (prefers-reduced-motion:reduce){.d{animation:none}}</style><div class=b><span class=d></span><span>REC</span><span class=t>00:00</span></div>'
  const t = ui.querySelector('.t')
  const tick = () => { const s = Math.max(0, Math.floor((Date.now() - started) / 1000)); t.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') }
  tick(); setInterval(tick, 500)
  ;(document.body || document.documentElement).appendChild(host)
})`

/** Começa a gravar a aba. Devolve stop(), que monta o mp4 e diz onde ficou (ou null). */
export async function startVideo(page, outFile) {
  const started = Date.now()
  const badge = () => page.evaluate(`${REC_BADGE}(${started})`).catch(() => {})
  await badge()
  // Navegação apaga o selo: recoloca (pelo lado do tb-run, que morre junto com a gravação).
  page.on('domcontentloaded', badge)
  const framesDir = `${outFile}.frames`
  fs.mkdirSync(framesDir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const frames = []
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = path.join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`)
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 })
    fs.writeFile(file, Buffer.from(data, 'base64'), () => {})
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 })
  return async () => {
    page.off('domcontentloaded', badge)
    await page.evaluate(() => document.getElementById('__ag_recbadge')?.remove()).catch(() => {})
    await cdp.send('Page.stopScreencast').catch(() => {})
    await cdp.detach().catch(() => {})
    await new Promise(r => setTimeout(r, 200)) // últimos arquivos terminando de gravar
    if (frames.length < 2) { fs.rmSync(framesDir, { recursive: true, force: true }); return null }
    // A página só manda quadro quando muda: cada quadro dura até o próximo.
    const end = Date.now() / 1000
    const list = frames.map((f, i) => {
      const next = frames[i + 1]?.t ?? Math.max(f.t + 0.5, Math.min(end, f.t + 2))
      return `file '${f.file}'\nduration ${Math.max(0.01, next - f.t).toFixed(3)}`
    })
    list.push(`file '${frames.at(-1).file}'`)
    const listFile = path.join(framesDir, 'lista.txt')
    fs.writeFileSync(listFile, list.join('\n'))
    const ok = await new Promise(r => execFile('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-movflags', '+faststart', outFile,
    ], err => r(!err)))
    fs.rmSync(framesDir, { recursive: true, force: true })
    return ok ? outFile : null
  }
}

// --- relatório ---

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const rel = (dir, file) => (file ? path.relative(dir, file).split(path.sep).join('/') : '')
const secs = ms => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
const plural = (k, um, varios) => `${k} ${k === 1 ? um : varios}`
const clock = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
// JSON dentro de <script>: nada de </script> nem separadores de linha do JS.
const jsonForScript = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

function hostOf(url) {
  try { return new URL(url).host } catch { return '' }
}

// Comportamento da página do relatório. Tudo que vem da página testada entra
// por textContent (nunca innerHTML): URL, corpo e console são dados de terceiros.
const REPORT_JS = String.raw`(() => {
  const $ = (s, el = document) => el.querySelector(s)
  const $$ = (s, el = document) => [...el.querySelectorAll(s)]
  const video = $('video')
  const raw = $('#tb-data')
  const data = raw ? JSON.parse(raw.textContent) : { network: [], consoleLog: [] }
  const clock = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0')
  const size = n => n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const isErr = r => r.failed || (typeof r.s === 'number' && r.s >= 400)
  const seek = t => { if (!video) return; video.currentTime = Math.max(0, t - 0.3); video.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); video.play().catch(() => {}) }
  const seekBtn = t => { if (!video) return el('span', null, clock(t)); const b = el('button', 'seek', clock(t)); b.type = 'button'; b.dataset.t = t; b.title = 'ver no vídeo'; return b }
  document.addEventListener('click', e => { const b = e.target.closest('.seek'); if (b) { e.stopPropagation(); seek(Number(b.dataset.t)) } })

  // Abas
  $$('.tabs [role=tab]').forEach(tab => tab.addEventListener('click', () => {
    $$('.tabs [role=tab]').forEach(t => t.setAttribute('aria-selected', String(t === tab)))
    $$('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.tab })
  }))

  // Rede
  const body = $('#net-body')
  let filter = 'all'
  const block = (title, content, open) => {
    const d = el('details'); if (open) d.open = true
    d.append(el('summary', null, title), el('pre', null, content))
    return d
  }
  const headers = h => h ? Object.entries(h).map(([k, v]) => k + ': ' + v).join('\n') : '(sem cabeçalhos)'
  const detailRow = r => {
    const tr = el('tr', 'detail'); const td = el('td'); td.colSpan = 7
    const wrap = el('div', 'detail')
    wrap.append(block('Geral', [r.m + ' ' + r.u, 'status: ' + (r.s ?? '—'), 'tipo: ' + r.type, 'duração: ' + (r.ms != null ? r.ms + ' ms' : '—'), 'tamanho: ' + (size(r.size) || '—'), r.roteiro ? 'roteiro: ' + r.roteiro : ''].filter(Boolean).join('\n'), true))
    wrap.append(block('Cabeçalhos da requisição', headers(r.reqHeaders)))
    if (r.reqBody) wrap.append(block('Payload', r.reqBody, true))
    wrap.append(block('Cabeçalhos da resposta', headers(r.resHeaders)))
    if (r.resBody) wrap.append(block('Resposta', r.resBody, true))
    td.append(wrap); tr.append(td); return tr
  }
  const rows = data.network.map(r => {
    const tr = el('tr', 'row' + (isErr(r) ? ' is-err' : '')); tr.tabIndex = 0; tr.dataset.t = r.t
    let u; try { u = new URL(r.u) } catch { u = null }
    const td = c => { const x = el('td', c); tr.append(x); return x }
    td('mono').append(seekBtn(r.t))
    td('mono').textContent = r.m
    td('st').textContent = r.failed ? '✗ ' + r.s : (r.s ?? '…')
    const url = td('url'); url.append(el('div', 'p', u ? u.pathname + u.search : r.u)); if (u) url.append(el('div', 'h', u.host))
    td('mono').textContent = r.type
    td('num').textContent = r.ms != null ? r.ms + ' ms' : ''
    td('num').textContent = size(r.size)
    let open = null
    const toggle = () => { if (open) { open.remove(); open = null } else { open = detailRow(r); tr.after(open) } }
    tr.addEventListener('click', toggle)
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })
    return { r, tr, close: () => { if (open) { open.remove(); open = null } } }
  })
  rows.forEach(x => body && body.append(x.tr))
  const apply = () => {
    const q = ($('#net-q')?.value || '').toLowerCase()
    let shown = 0
    for (const x of rows) {
      const r = x.r
      const okF = filter === 'all' || (filter === 'api' && (r.type === 'fetch' || r.type === 'xhr')) || (filter === 'doc' && r.type === 'document') || (filter === 'err' && isErr(r))
      const okQ = !q || (r.m + ' ' + r.u).toLowerCase().includes(q)
      x.tr.hidden = !(okF && okQ); if (x.tr.hidden) x.close(); else shown++
    }
    const empty = $('#net-empty'); if (empty) empty.hidden = shown > 0
  }
  $$('.seg button').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.f; $$('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); apply()
  }))
  $('#net-q')?.addEventListener('input', apply)

  // Console
  const con = $('#con-body')
  for (const m of data.consoleLog) {
    const tr = el('tr', 'lvl-' + m.type); tr.dataset.t = m.t
    const a = el('td', 'mono'); a.append(seekBtn(m.t))
    tr.append(a, el('td', 'lvl', m.type === 'pageerror' ? 'erro js' : m.type), el('td', 'msg', m.text))
    con && con.append(tr)
  }

  // Vídeo sincronizado: o que ainda não aconteceu fica apagado; o último que aconteceu, destacado.
  if (video) {
    const groups = [$$('#net-body tr.row'), $$('#con-body tr'), $$('.steps li.step[data-t]')]
    const sync = () => {
      const now = video.currentTime
      const started = video.played.length > 0 || now > 0
      for (const list of groups) {
        let last = null
        for (const row of list) {
          const future = started && Number(row.dataset.t) > now + 0.05
          if (row.tagName === 'TR') row.classList.toggle('is-future', future)
          row.classList.remove('is-now')
          if (!future && started) last = row
        }
        if (last) last.classList.add('is-now')
      }
    }
    video.addEventListener('timeupdate', sync)
    video.addEventListener('seeked', sync)
  }
})()`

/**
 * Escreve <dir>/index.html. results: [{ name, runs: [res] }] com os campos do runOne.
 * meta: { title, startedAt, totalMs, video, screen, flags }
 */
export function writeReport(dir, { title, results, video, startedAt, totalMs, screen, flags }) {
  const runs = results.flatMap(r => r.runs)
  const ok = runs.every(x => !x.failure)
  const steps = runs.reduce((a, r) => a + r.steps.length, 0)
  const checks = runs.flatMap(r => r.steps.filter(s => s.check))
  const firstUrl = runs.find(r => r.firstUrl)?.firstUrl ?? ''
  const when = new Date(startedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })

  const sections = results.map(r => r.runs.map((res, i) => {
    const f = res.failure
    const runTag = r.runs.length > 1 ? `<span class="chip">rodada ${i + 1} de ${r.runs.length}</span>` : ''
    const rows = res.steps.map((s, k) => `
        <li class="step ${s.ok ? 'is-ok' : 'is-bad'}"${s.t != null ? ` data-t="${s.t.toFixed(2)}"` : ''}>
          <span class="n">${k + 1}</span>
          <span class="mark" aria-label="${s.ok ? 'passou' : 'falhou'}">${s.ok ? '✓' : '✗'}</span>
          <span class="label">${esc(s.label)}${s.check ? ' <span class="chip chip-check">verificação</span>' : ''}</span>
          <span class="ms">${video && s.t != null ? `<button class="seek" type="button" data-t="${s.t.toFixed(2)}" title="ver no vídeo">${clock(s.t)}</button>` : ''}<span>${s.ms != null ? secs(s.ms) : ''}</span></span>
          ${s.shot ? `<a class="thumb" href="${esc(rel(dir, s.shot))}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(rel(dir, s.shot))}" alt="tela depois do passo ${k + 1}"></a>` : '<span class="thumb"></span>'}
        </li>`).join('')
    const fail = f ? `
      <div class="fail">
        <p class="fail-title">Falhou ${f.step ? `no passo ${f.index}: ${esc(f.step.label)}` : `na checagem de ${esc(f.kind ?? 'roteiro')}`}</p>
        <p class="mono">${esc(f.error)}</p>
        <p class="muted mono">${esc(f.diag?.url)}</p>
        ${f.diag?.shot && f.diag.shot.startsWith(dir) ? `<img class="fail-shot" src="${esc(rel(dir, f.diag.shot))}" alt="tela no momento da falha">` : ''}
      </div>` : ''
    const lists = [
      ['Rede com erro', res.net.map(x => `${x.m} ${x.u} → ${x.s}`)],
      ['Erros de JavaScript', res.jsErrors],
      ['Avisos', res.warnings],
      ['Anotações', res.notes],
    ].filter(([, xs]) => xs.length).map(([h, xs]) => `<div class="extra"><h4>${h}</h4><ul>${xs.map(x => `<li class="mono">${esc(x)}</li>`).join('')}</ul></div>`).join('')
    const cks = res.steps.filter(s => s.check)
    return `
    <section class="run ${f ? 'is-bad' : 'is-ok'}">
      <header class="run-head">
        <h2>${f ? '✗' : '✓'} ${esc(res.name === 'stdin' ? 'roteiro' : res.name)}</h2>
        ${runTag}
        <span class="muted">${plural(res.steps.length, 'passo', 'passos')} · ${cks.filter(c => c.ok).length}/${plural(cks.length, 'verificação', 'verificações')} · ${secs(res.ms)}</span>
      </header>
      ${fail}
      <ol class="steps">${rows}</ol>
      ${lists}
    </section>`
  }).join('')).join('')

  const network = runs.flatMap(r => r.network ?? []).sort((x, y) => x.t - y.t)
  const consoleLog = runs.flatMap(r => r.consoleLog ?? []).sort((x, y) => x.t - y.t)
  const errs = network.filter(e => e.failed || (typeof e.s === 'number' && e.s >= 400)).length
  const panel = network.length || consoleLog.length ? `
  <section class="panel" aria-label="Rede e console">
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-tab="rede">Rede<span class="count">${network.length}${errs ? ` · ${errs} com erro` : ''}</span></button>
      <button type="button" role="tab" aria-selected="false" data-tab="console">Console<span class="count">${consoleLog.length}</span></button>
    </div>
    <div data-pane="rede">
      <div class="filters">
        <div class="seg" role="group" aria-label="Filtrar requisições">
          <button type="button" data-f="all" aria-pressed="true">Tudo</button>
          <button type="button" data-f="api" aria-pressed="false">API</button>
          <button type="button" data-f="doc" aria-pressed="false">Documentos</button>
          <button type="button" data-f="err" aria-pressed="false">Erros</button>
        </div>
        <input id="net-q" type="search" placeholder="Filtrar por URL ou método" aria-label="Filtrar por URL ou método">
      </div>
      <div class="table-wrap">
        <table class="net">
          <thead><tr><th>${video ? 'Vídeo' : 'Tempo'}</th><th>Método</th><th>Status</th><th>URL</th><th>Tipo</th><th>Duração</th><th>Tamanho</th></tr></thead>
          <tbody id="net-body"></tbody>
        </table>
      </div>
      <p class="muted" id="net-empty" hidden>Nenhuma requisição com esse filtro.</p>
      <p class="note-redact">Cabeçalhos de credencial e campos como senha, token, CPF e cartão aparecem como •••.</p>
    </div>
    <div data-pane="console" hidden>
      <div class="table-wrap"><table class="con"><tbody id="con-body"></tbody></table></div>
      <p class="muted" id="con-empty" ${consoleLog.length ? 'hidden' : ''}>A página não escreveu nada no console.</p>
    </div>
  </section>
  <script type="application/json" id="tb-data">${jsonForScript({ network, consoleLog })}</script>` : ''

  const html = `<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: uma coluna de leitura; veredito no topo, vídeo, depois cada roteiro como lista de passos com a tela ao lado. */
:root {
  --bg: #f6f5f9; --surface: #ffffff; --ink: #1b1a22; --muted: #6a6778; --line: #e2e0ea;
  --accent: #6d3fd6; --ok: #157a3c; --ok-soft: #e3f4ea; --bad: #c62828; --bad-soft: #fbe6e6;
  --font-text: "Inter", ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0e0d13; --surface: #16151d; --ink: #ecebf2; --muted: #9b98ab; --line: #282632;
  --accent: #b391ff; --ok: #4ade80; --ok-soft: #12261a; --bad: #f87171; --bad-soft: #2a1515; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0e0d13; --surface: #16151d; --ink: #ecebf2; --muted: #9b98ab; --line: #282632;
  --accent: #b391ff; --ok: #4ade80; --ok-soft: #12261a; --bad: #f87171; --bad-soft: #2a1515; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--font-text); }
.wrap { max-width: 960px; margin: 0 auto; padding-block: 28px 56px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: grid; gap: 20px; }
.top { display: grid; gap: 10px; }
.verdict { display: inline-flex; align-items: center; gap: 8px; width: fit-content; padding: 4px 12px; border-radius: 999px;
  font-weight: 600; font-size: 13px; letter-spacing: .02em; }
.verdict.is-ok { background: var(--ok-soft); color: var(--ok); }
.verdict.is-bad { background: var(--bad-soft); color: var(--bad); }
h1 { margin: 0; font-size: clamp(22px, 4vw, 30px); line-height: 1.2; text-wrap: balance; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.meta b { color: var(--ink); font-weight: 500; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; }
.stat .v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
video { width: 100%; max-width: 100%; border-radius: 12px; border: 1px solid var(--line); background: #000; }
.run { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: grid; gap: 12px; min-width: 0; }
.run-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.run-head h2 { margin: 0; font-size: 17px; font-weight: 600; }
.run.is-ok .run-head h2 { color: var(--ok); }
.run.is-bad .run-head h2 { color: var(--bad); }
.muted { color: var(--muted); font-size: 13px; }
.mono { font-family: var(--font-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.chip { font-size: 11px; color: var(--accent); border: 1px solid currentColor; border-radius: 6px; padding: 0 6px; white-space: nowrap; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; }
.step { display: grid; grid-template-columns: 2.2em 1.4em minmax(0, 1fr) 4.5em 96px; align-items: center; gap: 10px;
  padding: 7px 0; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.step:first-child { border-top: 0; }
.step .n { color: var(--muted); font-size: 12px; text-align: right; }
.step .mark { font-weight: 600; }
.step.is-ok .mark { color: var(--ok); }
.step.is-bad .mark, .step.is-bad .label { color: var(--bad); }
.step .label { min-width: 0; overflow-wrap: anywhere; }
.step .ms { color: var(--muted); font-size: 12px; text-align: right; }
.thumb img { display: block; width: 96px; height: 60px; object-fit: cover; object-position: top; border-radius: 6px; border: 1px solid var(--line); }
.thumb:focus-visible img { outline: 2px solid var(--accent); outline-offset: 2px; }
.fail { background: var(--bad-soft); border-radius: 10px; padding: 10px 14px; display: grid; gap: 4px; }
.fail p { margin: 0; }
.fail-title { color: var(--bad); font-weight: 600; }
.fail-shot { margin-top: 8px; max-width: 100%; border-radius: 8px; border: 1px solid var(--line); }
.extra h4 { margin: 4px 0; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 500; }
.extra ul { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
footer { color: var(--muted); font-size: 12px; }
.step .ms { display: grid; justify-items: end; gap: 2px; }
.seek { font: 500 12px var(--font-mono); color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; font-variant-numeric: tabular-nums; }
.seek:hover { text-decoration: underline; }
.seek:focus-visible, .tabs button:focus-visible, .seg button:focus-visible, .net tbody tr.row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.step.is-now { background: color-mix(in srgb, var(--accent) 9%, transparent); }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px 14px; display: grid; gap: 10px; min-width: 0; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); }
.tabs button { font: 600 14px var(--font-text); color: var(--muted); background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px 8px; cursor: pointer; margin-bottom: -1px; }
.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
.count { font: 500 11px var(--font-mono); color: var(--muted); margin-left: 4px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { font: 500 12px var(--font-text); color: var(--muted); background: none; border: 0; padding: 5px 10px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--ink); }
.filters input { flex: 1 1 180px; min-width: 0; font: 13px var(--font-text); color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; }
.table-wrap { overflow-x: auto; max-height: 520px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; }
.net, .con { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.net th { position: sticky; top: 0; background: var(--surface); text-align: left; font-weight: 500; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.net td, .con td { padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.net tbody tr.row { cursor: pointer; }
.net tbody tr.row:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.net tr.is-err td.st, .net tr.is-err td.url .p { color: var(--bad); }
.net td.st { font-family: var(--font-mono); white-space: nowrap; }
.net td.url { min-width: 260px; max-width: 520px; }
.net td.url .p { overflow-wrap: anywhere; }
.net td.url .h { color: var(--muted); font-size: 11.5px; }
.net td.num { text-align: right; white-space: nowrap; color: var(--muted); }
.net td.mono, .con td.mono { font-family: var(--font-mono); white-space: nowrap; }
tr.is-future { opacity: .38; }
tr.is-now td { background: color-mix(in srgb, var(--accent) 12%, transparent); }
tr.detail td { background: var(--bg); padding: 10px 12px; }
.detail details { margin: 4px 0; }
.detail summary { cursor: pointer; font-weight: 600; font-size: 12.5px; }
.detail pre { margin: 6px 0 0; padding: 8px 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; max-height: 320px; overflow: auto; font: 12px/1.45 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.con td.lvl { font: 600 11px var(--font-mono); text-transform: uppercase; white-space: nowrap; color: var(--muted); }
.con tr.lvl-error td.lvl, .con tr.lvl-pageerror td.lvl, .con tr.lvl-error td.msg, .con tr.lvl-pageerror td.msg { color: var(--bad); }
.con tr.lvl-warning td.lvl { color: var(--accent); }
.con td.msg { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); }
.note-redact { color: var(--muted); font-size: 12px; margin: 0; }
@media (max-width: 560px) {
  .step { grid-template-columns: 1.8em 1.2em minmax(0, 1fr) 64px; }
  .step .ms { display: none; }
  .thumb img { width: 64px; height: 44px; }
}
</style>
<div class="wrap">
  <div class="top">
    <span class="verdict ${ok ? 'is-ok' : 'is-bad'}">${ok ? '✓ passou' : '✗ falhou'}</span>
    <h1>${esc(title)}</h1>
    <div class="meta">
      <span><b>${esc(when)}</b></span>
      ${firstUrl ? `<span>site <b>${esc(hostOf(firstUrl))}</b></span>` : ''}
      ${screen ? `<span>tela <b>${esc(screen)}</b></span>` : ''}
      ${flags?.length ? `<span>${esc(flags.join(' · '))}</span>` : ''}
    </div>
  </div>
  <div class="stats">
    <div class="stat"><div class="v">${plural(results.length, 'roteiro', 'roteiros')}</div><div class="k">executados</div></div>
    <div class="stat"><div class="v">${steps}</div><div class="k">passos</div></div>
    <div class="stat"><div class="v">${checks.filter(c => c.ok).length}/${checks.length}</div><div class="k">verificações ok</div></div>
    <div class="stat"><div class="v">${secs(totalMs)}</div><div class="k">duração</div></div>
  </div>
  ${video ? `<video controls playsinline preload="metadata" src="${esc(rel(dir, video))}"></video>` : ''}
  ${panel}
  ${sections}
  <script>${REPORT_JS}</script>
  <footer>Executado pelo Claude Code no navegador do painel (plugin navegador, tb-run). Cada miniatura é a tela logo depois do passo.</footer>
</div>
`
  const file = path.join(dir, 'index.html')
  fs.writeFileSync(file, html)
  return file
}
