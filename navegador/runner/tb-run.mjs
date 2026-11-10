// tb-run: roda roteiros Playwright no navegador do painel e devolve só o
// resumo. É o "code mode" do plugin navegador: em vez de uma chamada de
// ferramenta (e um snapshot) por clique, o agente escreve o fluxo uma vez e
// só o resultado entra na conversa.
//
// Conecta por CDP no mesmo navegador que a pessoa vê no painel e escolhe a
// aba pelo targetId (lib.mjs). Cada passo vira um evento em
// ~/.tbab/<navegador>/events.jsonl, que o card lê pra mostrar os passos.
//
// Uso:
//   tb-run roteiro.mjs     export default async ({ page, step, check, see, click, fill, api, log }) => { … }
//   tb-run e2e/            todos os .mjs da pasta, em ordem (os que começam com _ ficam de fora)
//   tb-run - <<'EOF'       o corpo da função, lido do stdin, com as mesmas variáveis
// Opções: tb-run --help

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ariaLines, asset, cleanOrigin, clip, connect, emulate, eventsWriter, fillIn, highlighter,
  removeEndcard, shortError, shot, sleep,
} from './lib.mjs'
import { redactUrl, startCapture } from './capture.mjs'
import { startVideo, writeReport } from './report.mjs'
import { uploadEvidence } from './upload.mjs'

const t0 = Date.now()

// --- argumentos ---

function parseArgs(argv) {
  const opts = {
    browser: process.env.TB_KEY || null, timeout: 10_000, pause: 250, shot: true, script: null,
    fail5xx: false, failJs: false, session: null, saveSession: null, clean: false, repeat: 1,
    report: false, reportDir: null, video: false, title: null, send: false, project: null, mobile: false, size: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--browser') opts.browser = argv[++i]
    else if (a === '--timeout') opts.timeout = Number(argv[++i])
    else if (a === '--pausa' || a === '--pause') opts.pause = Number(argv[++i])
    else if (a === '--sem-print' || a === '--no-shot') opts.shot = false
    else if (a === '--falhar-em-5xx' || a === '--fail-5xx') opts.fail5xx = true
    else if (a === '--falhar-em-erro-js' || a === '--fail-js') opts.failJs = true
    else if (a === '--sessao' || a === '--session') opts.session = argv[++i]
    else if (a === '--salvar-sessao' || a === '--save-session') opts.saveSession = argv[++i]
    else if (a === '--limpo' || a === '--clean') opts.clean = true
    else if (a === '--repetir' || a === '--repeat') opts.repeat = Math.max(1, Number(argv[++i]) || 1)
    else if (a === '--relatorio' || a === '--report') opts.report = true
    else if (a === '--relatorio-em' || a === '--report-dir') { opts.report = true; opts.reportDir = argv[++i] }
    else if (a === '--video') opts.video = true
    else if (a === '--evidencia' || a === '--evidence') { opts.report = true; opts.video = true }
    else if (a === '--titulo' || a === '--title') opts.title = argv[++i]
    else if (a === '--enviar' || a === '--send') { opts.report = true; opts.video = true; opts.send = true }
    else if (a === '--projeto' || a === '--project') opts.project = argv[++i]
    else if (a === '--celular' || a === '--mobile') opts.mobile = true
    else if (a === '--tela' || a === '--size') {
      const m = String(argv[++i]).match(/^(\d+)(?:x(\d+))?$/)
      if (!m) throw new Error('--tela espera LARGURA ou LARGURAxALTURA, ex.: 1280 ou 1280x800')
      opts.size = [Number(m[1]), m[2] ? Number(m[2]) : null]
    }
    else if (a === '-h' || a === '--help') opts.help = true
    else if (!opts.script) opts.script = a
  }
  return opts
}

const USAGE = `uso: tb-run <roteiro.mjs | pasta/ | -> [opções]
  roteiro.mjs : export default async ({ page, step, check, see, click, fill, api, log }) => { … }
  pasta/      : roda todos os .mjs da pasta em ordem (os que começam com _ ficam de fora)
  -           : corpo da função lido do stdin (heredoc), com as mesmas variáveis
execução:
  --browser <chave>          navegador (com mais de um aberto)
  --timeout <ms>             espera máxima por ação (padrão 10000)
  --pausa <ms>               pausa depois de cada passo (padrão 250; 0 roda seco)
  --limpo                    apaga storage e cookies da origem antes (e de cada origem nova do goto)
  --repetir <n>              roda cada roteiro n vezes e aponta passo instável
  --celular | --tela L[xA]   emula iPhone (390x844, toque) ou uma largura (altura = a do painel);
                             mais largo que o painel sai cortado na imagem; desfeito no fim
reprovação:
  --falhar-em-5xx            resposta 5xx reprova o roteiro
  --falhar-em-erro-js        erro de JavaScript na página reprova o roteiro
sessão:
  --sessao <arquivo.json>    carrega cookies e localStorage antes
  --salvar-sessao <arquivo>  salva cookies e localStorage do site atual no fim, se passou
evidência:
  --sem-print                não salva print na falha
  --relatorio                relatório HTML com um print por passo (--relatorio-em <pasta>)
  --video                    grava o painel em mp4 (precisa de ffmpeg)
  --evidencia                relatório + vídeo (pra mandar pra alguém ou guardar)
  --titulo "texto"           título do relatório
  --enviar                   --evidencia + manda pro Worker das evidências e devolve o link
                             curto …/e/<uuid> (config em ~/.config/navegador/evidencias.env)
  --projeto "nome"           projeto gravado no histórico (padrão: pasta do roteiro)`

// --- roteiros ---

const NAMES = 'page, context, browser, step, check, see, click, fill, type, press, select, hover, goto, api, log, net, sleep'

async function loadScript(arg) {
  if (arg === '-') {
    const body = fs.readFileSync(0, 'utf8')
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    return [{ name: 'stdin', file: null, run: new AsyncFunction('ctx', `const { ${NAMES} } = ctx;\n${body}`) }]
  }
  const abs = path.resolve(arg)
  if (!fs.existsSync(abs)) throw new Error(`roteiro não encontrado: ${abs}`)
  const files = fs.statSync(abs).isDirectory()
    ? fs.readdirSync(abs).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort().map(f => path.join(abs, f))
    : [abs]
  if (files.length === 0) throw new Error(`nenhum .mjs em ${abs}`)
  const out = []
  for (const file of files) {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.default !== 'function') throw new Error(`${path.basename(file)} precisa de export default async ({ page, step, … }) => { … }`)
    out.push({ name: path.basename(file), file, run: mod.default })
  }
  return out
}

// --- sessão (storageState do Playwright) ---

async function loadSession(page, file) {
  const state = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  const context = page.context()
  if (state.cookies?.length) await context.addCookies(state.cookies)
  const origins = (state.origins ?? []).filter(o => o.localStorage?.length)
  if (origins.length) {
    // Uma vez por aba e origem: depois disso o app manda (logout, etc.).
    const apply = os => {
      const o = os.find(x => x.origin === location.origin)
      if (!o || sessionStorage.getItem('__tb_sessao')) return
      for (const { name, value } of o.localStorage) localStorage.setItem(name, value)
      sessionStorage.setItem('__tb_sessao', '1')
    }
    await context.addInitScript(apply, origins)
    await page.evaluate(apply, origins).catch(() => {})
  }
  return `sessão carregada: ${state.cookies?.length ?? 0} cookies, ${origins.length} origens com localStorage`
}

async function saveSession(page, file) {
  const abs = path.resolve(file)
  // O contexto é o perfil inteiro do navegador do painel: fica só o site da
  // página atual (cookies do domínio e dos pais dele, localStorage da origem).
  const { hostname, origin } = new URL(page.url())
  const full = await page.context().storageState()
  const state = {
    cookies: full.cookies.filter(c => {
      const d = c.domain.replace(/^\./, '')
      return hostname === d || hostname.endsWith(`.${d}`)
    }),
    origins: full.origins.filter(o => o.origin === origin),
  }
  fs.writeFileSync(abs, JSON.stringify(state, null, 2), { mode: 0o600 })
  return `sessão salva: ${abs} (${hostname}: ${state.cookies.length} cookies, localStorage de ${state.origins.length} origem; tem segredo, não versione)`
}

const n = (k, um, varios) => `${k} ${k === 1 ? um : varios}`

// --- verificação de texto ---

// O padrão do getByText aceita qualquer pedaço e ignora maiúsculas: "Logado"
// passaria em "Deslogado". Aqui o padrão é palavra inteira e com maiúsculas;
// { exact: true } exige o texto inteiro do elemento; { parcial: true } volta
// ao jeito solto; RegExp passa como está.
export function textMatcher(text, o = {}) {
  if (text instanceof RegExp) return text
  if (o.exact) return new RegExp(`^\\s*${escapeRe(text)}\\s*$`, 'u')
  if (o.parcial) return new RegExp(escapeRe(text), 'iu')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(text)}(?![\\p{L}\\p{N}_])`, 'u')
}
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')

function seeLabel(text, o) {
  const how = o.exact ? ' (exato)' : o.parcial ? ' (parcial)' : ''
  const where = o.em ? ' na região' : ''
  if (text instanceof RegExp) return `ver ${clip(String(text), 40)}${where}`
  return `ver “${clip(text, 40)}”${how}${where}`
}

// Corpo esperado contido no recebido (objetos por chave, listas por posição).
function contains(expected, actual) {
  if (expected === actual) return true
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual)
  if (typeof expected !== 'object' || expected === null || typeof actual !== 'object' || actual === null) return false
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e, i) => contains(e, actual[i]))
  return Object.entries(expected).every(([k, v]) => contains(v, actual[k]))
}

// --- execução de um roteiro ---

function netLine(r) {
  let u = r.u
  try { const x = new URL(r.u); u = x.host + x.pathname } catch {}
  return `${r.m} ${clip(u, 90)} → ${r.s}`
}

async function runOne(script, env) {
  const { page, opts, emit, highlight, caption } = env
  const steps = []
  const notes = []
  const warnings = []
  const net = []
  const jsErrors = []
  let failure = null
  const start = Date.now()
  // --limpo: cada roteiro e cada rodada do --repetir começa do zero.
  if (opts.clean) {
    env.cleaned = new Set()
    const origin = await cleanOrigin(page)
    if (origin) env.cleaned.add(origin)
  }

  // Rede e erros da página enquanto o roteiro roda.
  // URLs passam pela mesma máscara da aba Rede: vão pro relatório e pro link compartilhado.
  const onResponse = r => { if (r.status() >= 400) net.push({ m: r.request().method(), u: redactUrl(r.url()), s: r.status() }) }
  const onFailed = r => {
    const why = r.failure()?.errorText ?? 'falhou'
    if (!/ERR_ABORTED/.test(why)) net.push({ m: r.method(), u: redactUrl(r.url()), s: why })
  }
  // Erro de recurso (404 de imagem…) já aparece na rede: aqui só JavaScript.
  const onPageError = e => jsErrors.push(clip(e.message, 200))
  const onConsole = m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) jsErrors.push(clip(m.text(), 200)) }
  page.on('response', onResponse)
  // Rede e console completos pro relatório (só com --relatorio/--evidencia).
  const stopCapture = env.reportDir ? startCapture(page, env.clock0, script.name) : null
  page.on('requestfailed', onFailed)
  page.on('pageerror', onPageError)
  page.on('console', onConsole)

  // Um passo: aparece no card, roda, e marca feito ou falhou. A falha para o
  // roteiro (lança de novo), igual a uma cadeia com &&.
  const runStep = async (label, fn, isCheck) => {
    const s = { label: clip(label, 80), check: isCheck, ok: false, ms: null, shot: null }
    steps.push(s)
    emit({ cmd: isCheck ? 'check' : 'step', ok: true, out: '', target: '', phase: 'add', label: s.label, check: isCheck })
    await caption(s.label)
    const began = Date.now()
    s.t = Math.max(0, (began - env.clock0) / 1000)
    try {
      // Limite por passo: código que espera sem prazo (evaluate, Promise solta)
      // não segura o roteiro pra sempre.
      const limit = Math.max(30_000, opts.timeout * 3)
      let timer
      const out = await Promise.race([
        fn(s),
        new Promise((_, ko) => { timer = setTimeout(() => ko(new Error(`passo travou: passou de ${limit / 1000}s sem terminar`)), limit) }),
      ]).finally(() => clearTimeout(timer))
      if (isCheck && out === false) throw new Error('a verificação devolveu false')
      s.ok = true
      return out
    } catch (err) {
      failure ??= { step: s, index: steps.length, error: shortError(err) }
      throw err
    } finally {
      s.ms = Date.now() - began
      emit({ cmd: isCheck ? 'check' : 'step', ok: s.ok, out: s.ok ? '✓' : clip(failure?.error, 200), target: '' })
      if (env.reportDir) {
        const file = path.join(env.reportDir, 'passos', `${String(++env.shotN).padStart(3, '0')}.jpg`)
        if (await shot(page, file, { jpeg: true })) s.shot = file
      }
      if (s.ok && opts.pause > 0) await sleep(opts.pause)
    }
  }

  // Ações com destaque no alvo: string vira page.locator(string).
  const loc = t => (typeof t === 'string' ? page.locator(t) : t)
  const nameOf = async l => clip(await l.first().evaluate(el =>
    String(el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '').trim().split('\n')[0],
    undefined, { timeout: 1_000 }).catch(() => ''), 36)
  // Uma espera só (a do timeout), dentro do passo. O nome do elemento chega
  // depois que ele aparece: vai pro card como evento 'start' (relabel).
  const act = async (target, verb, label, ripple, fn) => {
    const l = loc(target)
    return runStep(label ?? verb, async s => {
      await l.first().waitFor({ state: 'visible' })
      if (!label) {
        const name = await nameOf(l)
        if (name) {
          s.label = clip(`${verb} “${name}”`, 80)
          emit({ cmd: 'step', ok: true, out: '', target: name, phase: 'start' })
          await caption(s.label)
        }
      }
      await highlight(l, verb, ripple)
      return fn(l)
    }, false)
  }

  // fill/type: o texto vira rótulo do passo (card, legenda, relatório, link).
  // Campo de senha, ou com nome de senha/token/CPF/cartão, aparece como ••••;
  // { secret: true } força. Terceiro argumento: rótulo (string) ou { label, secret }.
  const SECRET_FIELD = /pass|senha|token|secret|cpf|cnpj|cvv|cvc|card|cart[aã]o|pin\b|otp/i
  const typeInto = (target, text, opt, sequential) => {
    const o = typeof opt === 'string' ? { label: opt } : (opt ?? {})
    const l = loc(target)
    return runStep(o.label ?? 'digitar', async s => {
      await l.first().waitFor({ state: 'visible' })
      const secret = o.secret || await l.first().evaluate((el, re) => el.type === 'password'
        || new RegExp(re, 'i').test(`${el.name ?? ''} ${el.id ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.autocomplete ?? ''} ${el.placeholder ?? ''}`),
      SECRET_FIELD.source, { timeout: 1_000 }).catch(() => false)
      const shown = secret ? '••••' : clip(String(text), 36)
      if (!o.label) {
        s.label = clip(`digitar “${shown}”`, 80)
        emit({ cmd: 'step', ok: true, out: '', target: shown, phase: 'start' })
        await caption(s.label)
      }
      await highlight(l, `digitar: ${secret ? '••••' : clip(String(text), 28)}`, false)
      if (sequential) { await l.fill(''); await l.pressSequentially(String(text), { delay: 25 }) } else await l.fill(String(text))
    }, false)
  }

  // --limpo também vale pra cada origem nova que o roteiro abrir.
  const goto = (url, label) => runStep(label ?? `abrir ${clip(url.replace(/^https?:\/\//, ''), 50)}`, async () => {
    const res = await page.goto(url)
    if (opts.clean) {
      const origin = new URL(page.url()).origin
      if (/^https?:/.test(origin) && !env.cleaned.has(origin)) env.cleaned.add(await cleanOrigin(page))
    }
    return res
  }, false)

  // Texto visível: palavra inteira, com maiúsculas, opcionalmente dentro de uma região.
  const see = (text, o = {}) => runStep(seeLabel(text, o), async () => {
    const base = o.em ? loc(o.em) : page
    const matches = base.getByText(textMatcher(text, o)).filter({ visible: true })
    await matches.first().waitFor({ state: 'visible', timeout: o.timeout })
    const count = await matches.count()
    if (count > 1 && !o.varios) warnings.push(`“${clip(String(text), 40)}” aparece em ${count} lugares${o.em ? ' na região' : ''}; prenda com { em: região } ou { exact: true } (ou { varios: true } se é isso mesmo)`)
  }, true)

  // A requisição que a tela dispara. Com ação: api(url, opções, () => click(…)).
  // Sem ação: const r = api(url, …); await click(…); await r.
  const api = (match, o = {}, action) => {
    const method = o.method?.toUpperCase()
    const hit = r => (match instanceof RegExp ? match.test(r.url()) : r.url().includes(match)) && (!method || r.request().method() === method)
    const waiting = page.waitForResponse(hit, { timeout: o.timeout ?? Math.max(opts.timeout, 15_000) })
    waiting.catch(() => {})
    const label = `API ${method ? `${method} ` : ''}${clip(String(match), 40)}${typeof o.status === 'number' ? ` → ${o.status}` : ''}`
    const verify = () => runStep(label, async () => {
      const r = await waiting
      const st = r.status()
      const statusOk = typeof o.status === 'number' ? st === o.status : typeof o.status === 'function' ? o.status(st) : st < 400
      if (!statusOk) throw new Error(`${r.request().method()} ${clip(r.url(), 100)} respondeu ${st}`)
      let body = null
      try { body = await r.json() } catch { body = await r.text().catch(() => null) }
      if (o.json !== undefined && !contains(o.json, body)) throw new Error(`corpo não bate: esperado ${clip(JSON.stringify(o.json, (k, v) => (v instanceof RegExp ? String(v) : v)), 120)}, veio ${clip(JSON.stringify(body), 200)}`)
      return { status: st, body }
    }, true)
    if (action) return Promise.resolve(action()).then(verify)
    return { then: (ok, ko) => verify().then(ok, ko) }
  }

  const ctx = {
    page,
    context: page.context(),
    browser: env.browser,
    sleep,
    net,
    step: (label, fn) => runStep(label, fn, false),
    check: (label, fn) => runStep(label, fn, true),
    see,
    goto,
    api,
    click: (t, label) => act(t, 'clicar', label, true, l => l.click()),
    hover: (t, label) => act(t, 'passar o mouse', label, false, l => l.hover()),
    fill: (t, text, opt) => typeInto(t, text, opt, false),
    // Digitação tecla a tecla, pra campo com máscara (CPF, telefone, valor).
    type: (t, text, opt) => typeInto(t, text, opt, true),
    select: (t, value, label) => act(t, `selecionar: ${clip(String(value), 28)}`, label ?? `selecionar “${clip(String(value), 36)}”`, false, l => l.selectOption(value)),
    press: (key, label) => runStep(label ?? `tecla ${key}`, () => page.keyboard.press(key), false),
    // O que o agente quer de volta na saída (valores lidos, contagens…).
    log: (...parts) => notes.push(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')),
  }

  try {
    await script.run(ctx)
  } catch (err) {
    // Erro fora de um step (código do roteiro): também é falha.
    failure ??= { step: null, index: steps.length, error: shortError(err) }
  }
  page.off('response', onResponse)
  page.off('requestfailed', onFailed)
  page.off('pageerror', onPageError)
  page.off('console', onConsole)

  const serverErrors = net.filter(r => typeof r.s === 'number' && r.s >= 500)
  if (!failure && opts.fail5xx && serverErrors.length) {
    failure = { step: null, index: steps.length, error: `${n(serverErrors.length, 'resposta', 'respostas')} 5xx durante o roteiro (--falhar-em-5xx)`, kind: 'rede' }
  }
  if (!failure && opts.failJs && jsErrors.length) {
    failure = { step: null, index: steps.length, error: `${n(jsErrors.length, 'erro', 'erros')} de JavaScript na página (--falhar-em-erro-js): ${clip(jsErrors[0], 160)}`, kind: 'JavaScript' }
  }
  // Retrato da página na hora da falha (na suíte, o próximo roteiro muda a página).
  if (failure) failure.diag = await snapshotFailure(page, opts, env.reportDir ?? env.dir)
  const captured = stopCapture ? await stopCapture() : { network: [], consoleLog: [] }
  return { name: script.name, steps, notes, warnings, net, jsErrors, failure, ms: Date.now() - start, firstUrl: redactUrl(page.url()), ...captured }
}

// --- saída ---

async function snapshotFailure(page, opts, dir) {
  const diag = { url: redactUrl(page.url()), title: await page.title().catch(() => ''), shot: null, aria: [] }
  if (opts.shot) {
    const file = path.join(dir, `falha-${Date.now()}.png`)
    if (await shot(page, file, { hideOverlays: true })) diag.shot = file
  }
  diag.aria = (await ariaLines(page)).lines
  return diag
}

function describe(res, { ariaMax, indent }) {
  const p = indent
  const lines = []
  const checks = res.steps.filter(s => s.check)
  const secs = `${(res.ms / 1000).toFixed(1)}s`
  const f = res.failure
  if (!f) {
    lines.push(`✓ ${res.name === 'stdin' ? 'roteiro ok' : res.name} · ${n(res.steps.length, 'passo', 'passos')} · ${checks.filter(c => c.ok).length}/${n(checks.length, 'verificação', 'verificações')} · ${secs}`)
    if (res.net.length) lines.push(`${p}rede: ${n(res.net.length, 'resposta', 'respostas')} com erro, ex.: ${res.net.slice(0, 3).map(netLine).join(' | ')}`)
    if (res.jsErrors.length) lines.push(`${p}JavaScript: ${n(res.jsErrors.length, 'erro', 'erros')}, ex.: ${clip(res.jsErrors[0], 160)}`)
  } else {
    const where = f.kind ? `checagem de ${f.kind}` : f.step ? `passo ${f.index} “${f.step.label}”` : `código do roteiro (depois do passo ${f.index})`
    lines.push(`✗ ${res.name === 'stdin' ? 'falhou' : `${res.name} falhou`} ${f.kind ? 'na' : 'no'} ${where} · ${n(res.steps.filter(s => s.ok).length, 'passo ok', 'passos ok')} antes · ${secs}`)
    lines.push(`${p}erro: ${f.error}`)
    const d = f.diag
    lines.push(`${p}url: ${d.url}`)
    if (d.title) lines.push(`${p}título: ${clip(d.title, 100)}`)
    if (res.net.length) {
      lines.push(`${p}rede com erro (${res.net.length}):`)
      for (const r of res.net.slice(-6)) lines.push(`${p}  ${netLine(r)}`)
    }
    if (res.jsErrors.length) lines.push(`${p}erros de JavaScript: ${res.jsErrors.slice(-4).join(' | ')}`)
    if (d.shot) lines.push(`${p}print: ${d.shot}`)
    // Um pedaço da página: o bastante pra corrigir o seletor sem snapshot.
    const aria = d.aria
    if (aria.length) {
      lines.push(`${p}página (${Math.min(aria.length, ariaMax)} de ${aria.length} linhas da árvore de acessibilidade; mais com tb-look):`)
      for (const row of aria.slice(0, ariaMax)) lines.push(`${p}  ${clip(row, 140)}`)
    }
  }
  for (const w of res.warnings) lines.push(`${p}aviso: ${w}`)
  for (const x of res.notes) lines.push(`${p}log: ${clip(x, 300)}`)
  return lines
}

// Com --repetir: uma linha de estabilidade e, se falhou alguma vez, a primeira falha detalhada.
function describeRuns(runs, opt) {
  if (runs.length === 1) return describe(runs[0], opt)
  const bad = runs.filter(r => r.failure)
  const avg = (runs.reduce((a, r) => a + r.ms, 0) / runs.length / 1000).toFixed(1)
  const name = runs[0].name === 'stdin' ? 'roteiro' : runs[0].name
  if (!bad.length) return [`✓ ${name} · estável ${runs.length}/${runs.length} · ${n(runs[0].steps.length, 'passo', 'passos')} · média ${avg}s`]
  const where = {}
  for (const r of bad) {
    const k = r.failure.step?.label ?? r.failure.kind ?? 'código do roteiro'
    where[k] = (where[k] ?? 0) + 1
  }
  const kind = bad.length === runs.length ? 'falhou sempre' : 'instável'
  const lines = [`✗ ${name} · ${kind}: ${runs.length - bad.length}/${runs.length} ok · onde falhou: ${Object.entries(where).map(([k, v]) => `“${k}” ${v}x`).join(', ')} · média ${avg}s`]
  lines.push(...describe(bad[0], opt).slice(1).map(l => l))
  return lines
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.script) {
    console.log(USAGE)
    process.exit(opts.help ? 0 : 2)
  }

  const scripts = await loadScript(opts.script)
  const { browser, page, dir, viewport } = await connect(opts.browser)
  page.setDefaultTimeout(opts.timeout)
  page.setDefaultNavigationTimeout(Math.max(opts.timeout, 30_000))
  await removeEndcard(page) // a tela final da rodada anterior tem texto que confundiria o getByText

  const capJs = asset('caption.js')
  const capTitle = (() => { try { return fs.readFileSync(path.join(dir, 'caption.txt'), 'utf8').trim() } catch { return '' } })()
  const caption = async sub => {
    if (!capJs || !capTitle) return
    await page.evaluate(fillIn(capJs, '$DATA', JSON.stringify({ title: capTitle, sub }))).catch(() => {})
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportDir = opts.report ? path.resolve(opts.reportDir ?? path.join(dir, 'relatorios', stamp)) : null
  if (reportDir) fs.mkdirSync(path.join(reportDir, 'passos'), { recursive: true })
  const emit = eventsWriter(dir)
  const env = { browser, page, dir, opts, emit, highlight: highlighter(page), caption, reportDir, shotN: 0, cleaned: new Set(), clock0: Date.now() }

  const header = []
  const { undo: undoEmulation, label: screenLabel, cropped } = await emulate(page, { mobile: opts.mobile, size: opts.size, panel: viewport })
  if (screenLabel) header.push(`  tela: ${screenLabel}`)
  if (cropped) header.push(`  aviso: tela maior que o painel (${viewport.width}x${viewport.height}): a parte de fora sai cortada no painel e no vídeo; pra ver inteira, alargue o painel ou aperte Cmd − nele`)
  else if (viewport && (viewport.width < 1000 || viewport.height < 500)) {
    // Painel estreito ou baixo: layout responsivo pode esconder menu/barra lateral.
    header.push(`  aviso: painel pequeno (${viewport.width}x${viewport.height}); se algo "sumir" (layout de celular), rode com --tela 1280 ou alargue o painel`)
  }
  let stopVideo = null
  const results = []
  try {
    if (opts.session) header.push(`  ${await loadSession(page, opts.session)}`)
    if (opts.clean) header.push('  limpo: storage e cookies da origem apagados antes de cada roteiro/rodada')
    if (opts.video) {
      const videoFile = reportDir ? path.join(reportDir, 'video.mp4') : path.join(dir, 'videos', `${stamp}.mp4`)
      fs.mkdirSync(path.dirname(videoFile), { recursive: true })
      stopVideo = await startVideo(page, videoFile)
      env.clock0 = Date.now() // 0:00 da rede, do console e dos passos = início do vídeo
      emit({ cmd: 'rec', ok: true, out: '', target: '', phase: 'rec', label: 'on' })
    }
    // Uma etapa no card por roteiro (suíte) e por rodada (--repetir).
    const chapters = scripts.length > 1 || opts.repeat > 1
    for (const script of scripts) {
      const runs = []
      for (let i = 0; i < opts.repeat; i++) {
        if (chapters) {
          const label = `${script.name === 'stdin' ? 'roteiro' : script.name}${opts.repeat > 1 ? ` (${i + 1}/${opts.repeat})` : ''}`
          emit({ cmd: 'chapter', ok: true, out: '', target: '', phase: 'chapter', label })
        }
        runs.push(await runOne(script, env))
      }
      results.push({ name: script.name, runs })
    }
  } finally {
    await undoEmulation()
  }
  const failed = results.filter(r => r.runs.some(x => x.failure))

  if (!failed.length && opts.saveSession) header.push(`  ${await saveSession(page, opts.saveSession)}`)
  const video = stopVideo ? await stopVideo() : null
  if (stopVideo) emit({ cmd: 'rec', ok: true, out: '', target: '', phase: 'rec', label: 'off' })
  if (opts.video) header.push(video ? `  vídeo: ${video}` : '  vídeo: não gerado (ffmpeg ausente ou sem quadros)')
  if (reportDir) {
    const base = opts.script === '-' ? 'roteiro' : path.basename(path.resolve(opts.script)).replace(/\.mjs$/, '')
    const flags = [opts.clean && 'limpo', opts.repeat > 1 && `${opts.repeat} rodadas`, opts.fail5xx && 'reprova em 5xx', opts.failJs && 'reprova em erro de JavaScript'].filter(Boolean)
    const screen = screenLabel ?? (viewport ? `${viewport.width}x${viewport.height} (painel)` : null)
    const file = writeReport(reportDir, { title: opts.title ?? (results.length > 1 ? `Suíte ${base}` : `Teste ${base}`), results, video, startedAt: t0, totalMs: Date.now() - t0, screen, flags })
    header.push(`  relatório: ${file}`)
    const extras = fs.readdirSync(reportDir, { recursive: true }).filter(p => /\.(jpg|png|mp4)$/.test(p)).map(String)
    const size = extras.reduce((a, p) => a + fs.statSync(path.join(reportDir, p)).size, 0)
    if (opts.send) {
      const allRuns = results.flatMap(r => r.runs)
      const checks = allRuns.flatMap(r => r.steps.filter(x => x.check))
      try {
        const sent = await uploadEvidence(reportDir, {
          title: opts.title ?? (results.length > 1 ? `Suíte ${base}` : `Teste ${base}`),
          project: opts.project ?? (scripts[0].file ? path.basename(path.dirname(scripts[0].file)) : null),
          passed: !failed.length,
          steps: allRuns.reduce((a, r) => a + r.steps.length, 0),
          checks: `${checks.filter(c => c.ok).length}/${checks.length}`,
          durationMs: Date.now() - t0,
        })
        header.push(`  link: ${sent.link}`)
        header.push(`  expira: ${new Date(sent.expiresAt).toLocaleString('pt-BR')} (${(size / 1048576).toFixed(1)} MB enviados)`)
        for (const note of sent.notes) header.push(`  envio: ${note}`)
      } catch (err) {
        header.push(`  envio falhou: ${shortError(err)}`)
      }
    } else {
      // O que a ferramenta Artifact precisa pra publicar o relatório como link.
      header.push(`  publicar: Artifact file_path=${file} files=${extras.length} arquivos de ${reportDir} (${(size / 1048576).toFixed(1)} MB)`)
    }
  }

  const out = []
  if (results.length === 1) {
    const [{ runs }] = results
    out.push(...describeRuns(runs, { ariaMax: 40, indent: '  ' }))
    if (!runs.some(r => r.failure)) out.splice(1, 0, `  url: ${page.url()}`)
  } else {
    out.push(`${failed.length ? '✗' : '✓'} suíte ${path.basename(path.resolve(opts.script))}/ · ${n(results.length, 'roteiro', 'roteiros')} · ${results.length - failed.length} ok · ${n(failed.length, 'falhou', 'falharam')} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    for (const r of results) {
      for (const l of describeRuns(r.runs, { ariaMax: 20, indent: '      ' })) out.push(`  ${l}`)
    }
  }
  out.splice(1, 0, ...header)
  const firstFail = failed[0]?.runs.find(x => x.failure)
  await caption(firstFail ? `falhou: ${firstFail.failure.step?.label ?? firstFail.name}` : 'roteiro ok')
  console.log(out.join('\n'))
  // Sem browser.close(): o navegador é o do painel, só desconecta.
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.log(`✗ tb-run: ${shortError(err)}`)
  process.exit(2)
})
