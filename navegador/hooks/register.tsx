/* @jsx h */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Bridge } from '../types'
import { MAX_IMAGE_CELLS } from './surface.tsx'
import { isWorkspacePage, normalizeUrl } from './urls.ts'
import { parseBrowserSteps, parseEvents, relabel, type Step } from './activity.ts'
import {
  activeMs,
  BG,
  chaptersOf,
  COLLAPSED_ROWS,
  formatMs,
  reportChapters,
  STATUS_ROWS,
  TOGGLE_ROOM,
  type CardProps,
  type ConsoleMsg,
  type Req,
} from './card.tsx'
import { claimBlit, forgetPicture, pictureToDraw, releaseBlit } from './picture.ts'
import { chromeSwitch, chromeWatch } from './chrome.ts'
import {
  isBridgeState,
  isInputMessage,
  isLaunchReport,
  isSizeMessage,
  takenItems,
  type BridgeState,
  type Frame,
} from './bridge-protocol.ts'



const PANE = 'browser'
const IMAGE_KEY = 'view'
const IMAGE_ALT = ''
const OPEN_TOOL = 'mcp__navegador__open'
const CLOSE_TOOL = 'mcp__navegador__close'
const START_URL = 'terminal-browser://start'
const INSTALL_URL = 'https://terminal-browser.sh'
const REQUIRED_CAPABILITIES = ['embedding', 'image-frames']
const WATCH_RETRY_MS = 250
const DENIED_REDRAW_MS = 500
const DENIALS_BEFORE_LOGGING = 3
// O painel aceita até 120 blits/s; página com vídeo manda mais que isso.
// Segura ~30 quadros por segundo, que é o que o terminal mostra de fato.
const MIN_BLIT_MS = 33
// O aviso de blit recusado sai uma vez por carga do módulo, não a cada rajada.
let loggedBlitRefusal = false
// Pede o painel o mais largo e alto que o layout deixar; arrastar ainda manda.
const WANT_COLUMNS = 255
const WANT_ROWS = 200
const STEPS_KEPT = 300
// Site que anima o título (contador, letreiro) não refaz o painel a cada troca.
const TITLE_MIN_MS = 2000


const state = {
  port: null as number | null,
  token: null as string | null,
  open: false,
  pendingUrl: null as string | null,
  region: null as { cols: number; rows: number } | null,
  last: null as BridgeState | null,
  frame: null as Frame | null,
  // Quadro que o último desenho do painel pôs no <Image>. Redesenhar com ele
  // não reenvia nada; o blit troca a figura por baixo.
  drawn: null as Frame | null,
  // shm do quadro mais novo já entregue ao terminal (por desenho ou blit).
  // O terminal apaga o shm ao ler: mandar o mesmo nome de novo dá imagem
  // recusada, e a figura some até o próximo quadro (o "pisca").
  sentShm: null as string | null,
  mounted: null as { cols: number; rows: number } | null,
  // Painel remontado (reaberto): o próximo tamanho vai por /open, que faz a
  // ponte mandar quadro novo mesmo numa página parada (/size igual não faz).
  reshow: false,
  // Título da aba: aplicado no máximo uma vez por TITLE_MIN_MS.
  title: null as string | null,
  titleShownAt: 0,
  // Navegador da ponte aberto sem a barra de endereço (TERMINAL_BROWSER_NO_CHROME).
  chromeless: false,
  watcher: 0,
  // a hack to programatically trigger agent input focus
  viewGeneration: 0,
}

// O que o agente fez no navegador nesta rodada de uso, pra faixa de status.
const activity = {
  steps: [] as Step[],
  startedAt: 0,
  finishedAt: null as number | null,
  // A descrição que o agente deu ao comando Bash: vira o título do card.
  intent: null as string | null,
  // Um capítulo por comando Bash: a intenção dele. O relatório lista capítulos.
  chapters: [] as string[],
  // Eventos do wrapper (um por ação) já aplicados nesta rodada de Bash.
  eventsSeen: 0,
  polling: null as { cancel: () => void } | null,
}

// A ponte em $.state: depois de um /reload-plugins o módulo recomeça do zero,
// mas a ponte e o navegador dela continuam vivos e são reaproveitados.
const savedBridge = atom({ plugin: 'navegador', key: 'bridge' } as const, null as Bridge | null)

// Trabalho solto, sem await. Num /reload-plugins o ambiente do módulo é
// descarregado e o que estava esperando (o laço da ponte, um timer) rejeita;
// sem o catch, cada um vira "rejection nothing handled".
const detach = (work: Promise<unknown>): void => {
  work.catch(() => {})
}

const bridgeUrl = (path: string) => `http://127.0.0.1:${state.port}${path}`
const authHeaders = () => ({ authorization: `Bearer ${state.token}` })
const viewKey = () => `view${state.viewGeneration}`


async function terminalBrowserCommand($: EngineInterface): Promise<string[]> {
  const checkoutCli = `${$.plugin.root}/../cli/dist/main.js`
  if (await $.fs.exists(checkoutCli)) return ['node', checkoutCli] // dev case
  return ['terminal-browser']
}

async function checkCapabilities($: EngineInterface, command: string[]): Promise<{ ok: true } | { ok: false; installed: boolean }> {
  let result: { stdout: string; exitCode: number }
  try {
    result = await $.process.run([...command, 'capabilities'], { timeoutMs: 10_000 })
  } catch {
    return { ok: false, installed: false }
  }
  let capabilities: string[] = []
  if (result.exitCode === 0) {
    const line = result.stdout.split('\n').find((text: string) => text.startsWith('{'))
    try {
      const parsed = line ? JSON.parse(line) : null
      if (parsed && Array.isArray(parsed.capabilities)) capabilities = parsed.capabilities
    } catch {}
  }
  const ok = REQUIRED_CAPABILITIES.every(need => capabilities.includes(need))
  return ok ? { ok: true } : { ok: false, installed: true }
}

// `chromeless`: o navegador da ponte nasce sem a barra de endereço (modo de
// trabalho, VS Code no painel). O terminal-browser só lê isso ao nascer.
async function startBridge($: EngineInterface, chromeless = false): Promise<{ ok: true } | { ok: false; error: string }> {
  const command = await terminalBrowserCommand($)
  const check = await checkCapabilities($, command)
  if (!check.ok) {
    return {
      ok: false,
      error: check.installed
        ? 'Newer terminal-browser version required, run terminal-browser upgrade'
        : `Please install terminal-browser first - ${INSTALL_URL}`,
    }
  }
  let report: unknown = null
  try {
    const { stdout, stderr, exitCode } = await $.process.run([...command, 'claude-bridge', 'launch'], {
      timeoutMs: 20_000,
      env: chromeless ? { TERMINAL_BROWSER_NO_CHROME: '1' } : {},
    })
    const line = stdout.split('\n').find((text: string) => text.startsWith('{'))
    report = line ? JSON.parse(line) : { error: stderr.trim() || `exit ${exitCode}`, code: 'start' }
  } catch (err) {
    report = { error: String(err), code: 'start' }
  }
  if (!isLaunchReport(report) || !('port' in report)) {
    const detail = isLaunchReport(report) && 'error' in report ? report.error : 'terminal-browser could not start'
    return { ok: false, error: `${detail}` }
  }
  state.port = report.port
  state.token = report.token
  state.chromeless = chromeless
  await update($, savedBridge, () => ({ port: report.port, token: report.token, chromeless }))
  detach(watchBridge($))
  return { ok: true }
}

async function post($: EngineInterface, path: string, body: unknown): Promise<unknown> {
  if (state.port === null) return null
  try {
    const response = await $.http.fetch(bridgeUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    })
    return response.ok ? JSON.parse(response.text || '{}') : null
  } catch {
    return null
  }
}

async function fetchState($: EngineInterface, version: number): Promise<BridgeState | null> {
  if (state.port === null) return null
  try {
    const response = await $.http.fetch(bridgeUrl(`/state?version=${version}`), { headers: authHeaders() })
    const parsed: unknown = response.ok ? JSON.parse(response.text) : null
    return isBridgeState(parsed) ? parsed : null
  } catch {
    return null
  }
}


function imageSource(frame: Frame) {
  return { shm: frame.shm, format: frame.format, width: frame.width, height: frame.height, generation: frame.generation }
}

function imageGrid(frame: Frame, cols: number, rows: number) {
  return {
    cols: Math.max(1, Math.min(frame.cols, cols, MAX_IMAGE_CELLS)),
    rows: Math.max(1, Math.min(frame.rows, rows, MAX_IMAGE_CELLS)),
  }
}

function fitsMounted(frame: Frame): boolean {
  const mounted = state.mounted
  if (!mounted || !state.region) return false
  const grid = imageGrid(frame, state.region.cols, state.region.rows)
  return grid.cols === mounted.cols && grid.rows === mounted.rows
}

async function watchBridge($: EngineInterface): Promise<void> {
  const watcher = ++state.watcher
  const live = () => state.watcher === watcher && state.port !== null
  let version = -1
  let denials = 0
  let lastDeniedRedraw = 0
  let lastBlitAt = 0
  while (live()) {
    const fresh = await fetchState($, version)
    if (!live()) return
    if (!fresh) {
      await $.clock.sleep(WATCH_RETRY_MS)
      continue
    }
    version = fresh.version
    const previous = state.last
    state.last = fresh
    if (fresh.inbox > 0) await deliverAgentText($)
    if (!state.open) continue
    // VS Code no painel sem barra de endereço; página comum com ela.
    const bare = fresh.alive && fresh.url
      ? chromeSwitch(chromeState, workspaceMode(), fresh.title, fresh.url, state.chromeless, Date.now())
      : null
    if (bare !== null && fresh.url) {
      detach(switchChrome($, bare, fresh.url))
      return
    }
    const pictureGone = fresh.frame === null && state.frame !== null
    if (pictureGone) forgetPicture(state)
    // O título não aparece no desenho: só a aba do painel, e com freio.
    const paneChanged =
      !previous
      || pictureGone
      || previous.alive !== fresh.alive
      || previous.error !== fresh.error
    if (paneChanged) $.ui.invalidate('ui.render')
    await showTitle($, fresh.title)
    const frame = fresh.frame
    if (!frame || frame.generation === state.frame?.generation) continue
    state.frame = frame
    if (!fitsMounted(frame)) {
      $.ui.invalidate('ui.render')
      continue
    }
    const sinceBlit = Date.now() - lastBlitAt
    if (sinceBlit < MIN_BLIT_MS) await $.clock.sleep(MIN_BLIT_MS - sinceBlit)
    // Um desenho durante a espera pode já ter levado este quadro.
    if (!claimBlit(state, frame)) continue
    lastBlitAt = Date.now()
    const result = await $.ui.blit({ requestId: PANE, key: IMAGE_KEY, source: imageSource(frame) })
    if (!result.deny) {
      denials = 0
      continue
    }
    releaseBlit(state, frame)
    denials += 1
    if (denials === DENIALS_BEFORE_LOGGING && !loggedBlitRefusal) {
      loggedBlitRefusal = true
      $.ui.log(`navegador: quadros do navegador recusados pelo painel (${result.deny}); aviso único`)
    }
    const now = Date.now()
    if (now - lastDeniedRedraw >= DENIED_REDRAW_MS) {
      lastDeniedRedraw = now
      $.ui.invalidate('ui.render')
    }
  }
}

// Reabre o navegador com ou sem a barra de endereço, no mesmo endereço: derruba
// a ponte (e o navegador dela) e sobe outra com o env certo. Pisca uma vez e a
// aba perde o histórico de voltar.
const chromeState = chromeWatch()
let switchingChrome = false
async function switchChrome($: EngineInterface, chromeless: boolean, url: string): Promise<void> {
  if (switchingChrome) return
  switchingChrome = true
  try {
    await post($, '/close', {})
    state.watcher += 1
    state.port = null
    state.token = null
    state.last = null
    ownKey = null
    const started = await startBridge($, chromeless)
    if (!started.ok) {
      $.ui.log(`navegador: não reabriu ${chromeless ? 'sem' : 'com'} a barra: ${started.error}`)
      return
    }
    state.pendingUrl = url
    remount()
    $.ui.invalidate('ui.render')
  } finally {
    switchingChrome = false
  }
}

// Painel desenhado sem ponte no módulo: um /reload-plugins com o painel aberto.
// Reencontra a ponte guardada em $.state, pega o estado (título: o modo
// workspace vale já no próximo desenho) e remonta a superfície, que manda o
// tamanho de novo; com `reshow`, ele vai por /open e a ponte manda um quadro
// novo. Antes disso o painel ficava preto até alguém chamar o open.
let reattaching = false
function reattach($: EngineInterface): void {
  if (state.port !== null || reattaching || switchingChrome) return
  reattaching = true
  detach((async () => {
    try {
      const saved = await read($, savedBridge)
      if (!saved || state.port !== null) return
      state.port = saved.port
      state.token = saved.token
      state.chromeless = saved.chromeless === true
      const fresh = await fetchState($, -1)
      if (!fresh) {
        state.port = null
        state.token = null
        return
      }
      state.last = fresh
      remount()
      detach(watchBridge($))
      $.ui.invalidate('ui.render')
    } finally {
      reattaching = false
    }
  })())
}

// jq e python3 são dos scripts bin/: sem eles o navegador abre, mas some o
// que eles fazem. Avisa uma vez por carga do módulo, dizendo o que se perde.
let depsChecked = false
async function warnMissingDeps($: EngineInterface): Promise<void> {
  if (depsChecked) return
  depsChecked = true
  const missing: string[] = []
  for (const [bin, lost] of [
    ['jq', 'jq (card passo a passo, rede e desenho na página)'],
    ['python3', 'python3 (digitação letra por letra)'],
  ] as const) {
    const found = await $.process.run(['sh', '-c', `command -v ${bin}`], { timeoutMs: 5_000 }).then(r => r.exitCode === 0).catch(() => true)
    if (!found) missing.push(lost)
  }
  if (missing.length > 0) $.ui.toast(`navegador: falta ${missing.join(' e ')}. Instale pra ter tudo.`)
}

async function openBrowser($: EngineInterface, raw: string | null): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  // Rodada anterior já terminou: abrir de novo começa um card limpo.
  if (activity.finishedAt !== null || !state.open) {
    resetActivity()
    clearBrowserLog($)
    $.ui.invalidate('ui.render')
  }
  // Módulo recém-carregado (reload): reaproveita a ponte guardada, se viva.
  if (state.port === null) {
    const saved = await read($, savedBridge)
    if (saved) {
      state.port = saved.port
      state.token = saved.token
      state.chromeless = saved.chromeless === true
      const fresh = await fetchState($, -1)
      if (fresh) {
        state.last = fresh
        detach(watchBridge($))
      } else {
        state.port = null
        state.token = null
      }
    }
  }
  // Ponte antiga morta (o daemon reiniciou): esquece a porta e sobe outra.
  if (state.port !== null && (await fetchState($, -1)) === null) {
    state.watcher += 1
    state.port = null
    state.token = null
    state.last = null
  }
  if (state.port === null) {
    const started = await startBridge($, state.chromeless)
    if (!started.ok) return started
  }
  detach(warnMissingDeps($))
  const alive = state.last?.alive === true
  const url = raw ? normalizeUrl(raw) : (alive && state.last?.url ? state.last.url : START_URL)
  // Painel já aberto: troca o endereço na própria aba. O /open da ponte abre
  // uma aba nova, e com duas abas as refs (@eN) do agente passam a falhar.
  // Vale também com o painel fechado: o navegador da ponte continua vivo e o
  // /open abriria uma segunda aba (as refs @eN se embaralham entre as duas).
  if (raw && alive && (await navigateInPlace($, url))) {
    if (!state.open || state.region === null) {
      remount()
    }
    state.open = true
    // A aba volta a "navegador"; o título da página entra de novo pelo showTitle.
    state.title = null
    state.titleShownAt = 0
    await $.ui.open({ id: PANE, title: 'navegador', focus: true, rows: WANT_ROWS, columns: WANT_COLUMNS })
    $.ui.invalidate('ui.render')
    return { ok: true, url }
  }
  state.pendingUrl = url
  // Reabrindo um painel fechado: remonta a superfície, que só manda o tamanho
  // quando muda; sem tamanho o /open nunca sai (dava tela cinza). Com o painel
  // já aberto, o tamanho de agora vale e a página só troca de endereço.
  if (!state.open || state.region === null) {
    remount()
  }
  state.open = true
  // A aba volta a "navegador"; o título da página entra de novo pelo showTitle.
  state.title = null
  state.titleShownAt = 0
  await $.ui.open({ id: PANE, title: 'navegador', focus: true, rows: WANT_ROWS, columns: WANT_COLUMNS })
  $.ui.invalidate('ui.render')
  // O tamanho pode ter chegado durante o await (ui.message); o TS não vê isso.
  const region = state.region as { cols: number; rows: number } | null
  if (region) {
    state.pendingUrl = null
    await post($, '/open', { url, ...region })
  }
  return { ok: true, url }
}

// O navegador desta sessão, pelo terminal (tty) do Claude Code: a mesma regra
// da ponte. Sem isso, com outra sessão também de navegador aberto, o `action`
// recusa ("several browsers match") e o plugin abria uma segunda aba.
async function ownBrowserKey($: EngineInterface, command: string[]): Promise<string | null> {
  try {
    // Sobe pelos pais do sh até o primeiro com terminal: o desta sessão.
    const climb = 'p=$PPID; i=0; while [ $i -lt 8 ] && [ -n "$p" ] && [ "$p" != 1 ]; do t=$(ps -o tty= -p $p | tr -d " "); case "$t" in ""|"??") p=$(ps -o ppid= -p $p | tr -d " ");; *) echo "$t"; exit 0;; esac; i=$((i+1)); done'
    const tty = (await $.process.run(['sh', '-c', climb], { timeoutMs: 5_000 })).stdout.trim()
    if (!tty || tty.includes('?')) return null
    const listed = await $.process.run([...command, 'ls', '--all', '--json'], { timeoutMs: 5_000 })
    const parsed = JSON.parse(listed.stdout || '[]') as unknown
    const rows = (Array.isArray(parsed) ? parsed : ((parsed as { browsers?: unknown[] }).browsers ?? [])) as { key?: unknown; tty?: unknown }[]
    const mine = rows.find(row => row.tty === `/dev/${tty}` || row.tty === tty)
    return typeof mine?.key === 'string' ? mine.key : null
  } catch {
    return null
  }
}

// A chave muda pouco (só quando o navegador reinicia): guardada por 30 s pra
// não rodar `ps` e `ls` a cada comando do agente.
const OWN_KEY_MS = 30_000
let ownKey: { key: string | null; at: number } | null = null

async function browserKey($: EngineInterface): Promise<string | null> {
  const now = Date.now()
  if (ownKey && now - ownKey.at < OWN_KEY_MS) return ownKey.key
  const key = await ownBrowserKey($, await terminalBrowserCommand($))
  ownKey = { key, at: now }
  return key
}

// Scripts do próprio plugin (bin/): nada fora da pasta dele precisa existir.
const binPath = ($: EngineInterface, name: 'tb-agent-browser' | 'tb-net' | 'tb-page-js') => `${$.plugin.root}/bin/${name}`

// Pasta deste navegador em ~/.tbab: eventos e legenda trocados com o wrapper.
// Uma por navegador, pra duas sessões abertas não misturarem os cards.
async function tbabDir($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  if (!home) return null
  const key = await browserKey($)
  return key && /^[\w.-]+$/.test(key) ? `${home}/.tbab/${key}` : `${home}/.tbab`
}

// Env pros scripts bin/tb-*: sem TB_KEY eles pegam o primeiro
// navegador da aba do terminal, que pode ser o de outra sessão.
async function scriptEnv($: EngineInterface): Promise<Record<string, string>> {
  const key = await browserKey($)
  return key ? { TB_KEY: key } : {}
}

async function navigateInPlace($: EngineInterface, url: string): Promise<boolean> {
  const [step] = await beginSteps($, [{ label: `abrir ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`, check: false }], null)
  let ok = false
  try {
    const command = await terminalBrowserCommand($)
    const key = await browserKey($)
    const ran = await $.process.run(
      [...command, 'action', ...(key ? ['--browser', key] : []), '--', 'eval', `location.href = ${JSON.stringify(url)}`],
      { timeoutMs: 15_000, env: { TERMINAL_BROWSER_AGENT: binPath($, 'tb-agent-browser') } },
    )
    ok = ran.exitCode === 0
  } catch {}
  // Falhou: a chave guardada pode ser de um navegador que já fechou.
  if (!ok) ownKey = null
  if (step) await endSteps($, [step], !ok, false)
  return ok
}

async function closeBrowser($: EngineInterface): Promise<boolean> {
  if (!state.open) return false
  await $.ui.close({ id: PANE })
  return true
}

// Painel (re)montado: Client novo (manda o tamanho de novo) e figura do zero;
// o tamanho seguinte vai por /open pra ponte mandar um quadro novo.
function remount(): void {
  state.region = null
  state.viewGeneration += 1
  state.reshow = true
  forgetPicture(state)
}

// Título da aba do painel. Troca no máximo a cada TITLE_MIN_MS; o último
// título que chegou no meio vale na volta seguinte do watchBridge (ela volta
// pelo menos a cada segundo, o tempo de espera do /state).
async function showTitle($: EngineInterface, title: string): Promise<void> {
  const wanted = title ? title.slice(0, 40) : null
  if (!wanted || wanted === state.title) return
  const now = Date.now()
  if (now - state.titleShownAt < TITLE_MIN_MS) return
  state.title = wanted
  state.titleShownAt = now
  await $.ui.open({ id: PANE, title: wanted, rows: WANT_ROWS, columns: WANT_COLUMNS })
}

async function browserClosed($: EngineInterface): Promise<void> {
  stopNetPolling()
  resetActivity()
  state.open = false
  state.pendingUrl = null
  state.region = null
  state.reshow = false
  state.title = null
  forgetPicture(state)
  state.mounted = null
  await post($, '/browser/close', {})
}

async function deliverAgentText($: EngineInterface): Promise<void> {
  const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  const lines = takenItems(await post($, '/inbox/take', {}))
    .filter(item => item.text.trim() !== '')
    .flatMap(item => [oneLine(item.text), ...(item.screenshot ? [oneLine(item.screenshot)] : [])])
  if (lines.length === 0) return
  const { isFilled } = await $.prompt.fill({ text: `${lines.join('\n')}\n` })
  if (!isFilled) {
    // would need to see a case this happens before shipping
    // $.ui.toast('copied to clipboard')
    return
  }
  state.viewGeneration += 1
  $.ui.invalidate('ui.render')
}


// --- card de status: o que o agente está fazendo no navegador ---
//
// Duas fontes. O hook do Bash lê o comando (os passos planejados, como
// "próximo") e a descrição dele (o título do card). O wrapper tb-agent-browser
// grava um evento por ação em ~/.tbab/<navegador>/events.jsonl; lido
// durante o comando, ele avança o card passo a passo mesmo em ações encadeadas.

const EVENTS_POLL_MS = 150

// Roda caption.js / endcard.js na página pelo bin/tb-page-js (direto
// no agent-browser: não acende o indicador nem vira evento). Sem esperar.
function pageScript($: EngineInterface, name: 'caption' | 'endcard', data: unknown): void {
  detach((async () => {
    const env = await scriptEnv($)
    await $.process.run([binPath($, 'tb-page-js'), name, JSON.stringify(data)], { timeoutMs: 10_000, env }).catch(() => {})
  })())
}

// Título da legenda: a intenção da etapa. O wrapper lê o arquivo a cada ação
// pra recolocar a legenda se a página mudou.
async function setCaption($: EngineInterface, title: string | null): Promise<void> {
  const dir = await tbabDir($)
  if (!dir) return
  await $.fs.write(`${dir}/caption.txt`, title ?? '').catch(() => {})
  pageScript($, 'caption', title ? { title, sub: '' } : { hide: true })
}

async function eventsPath($: EngineInterface): Promise<string | null> {
  const dir = await tbabDir($)
  return dir ? `${dir}/events.jsonl` : null
}

// O primeiro passo "próximo" vira o que está rodando, se nenhum estiver.
function advance(now: number): void {
  if (activity.steps.some(step => step.status === 'working')) return
  const nextStep = activity.steps.find(step => step.status === 'next')
  if (!nextStep) return
  nextStep.status = 'working'
  nextStep.startedAt = now
}

async function beginSteps(
  $: EngineInterface,
  planned: { label: string; check: boolean }[],
  intent: string | null,
): Promise<Step[]> {
  const now = await $.clock.now()
  if (activity.finishedAt !== null || activity.steps.length === 0) {
    activity.steps = []
    activity.startedAt = now
    activity.finishedAt = null
    activity.intent = null
    activity.chapters = []
  }
  if (intent) activity.intent = intent
  activity.chapters.push(intent ?? planned[0]?.label ?? 'roteiro')
  if (intent) await setCaption($, intent)
  const chapter = activity.chapters.length - 1
  const added = planned.map((p): Step => ({ label: p.label, status: 'next', startedAt: now, ms: null, check: p.check, chapter }))
  activity.steps = [...activity.steps, ...added].slice(-STEPS_KEPT)
  advance(now)
  $.ui.invalidate('ui.render')
  return added
}

// Leituras do events.jsonl em fila: duas sobrepostas aplicavam o mesmo
// evento duas vezes (as duas cortavam a partir do mesmo eventsSeen).
let eventsChain: Promise<unknown> = Promise.resolve()
let eventsPending = false
// Tamanho do arquivo na última leitura: sem mudança, nem lê (só um stat).
let eventsSize = -1

function pollEvents($: EngineInterface, path: string): Promise<number> {
  eventsPending = true
  const run = eventsChain.then(() => readEvents($, path)).finally(() => { eventsPending = false })
  eventsChain = run.catch(() => {})
  return run
}

async function readEvents($: EngineInterface, path: string): Promise<number> {
  let text = ''
  try {
    const { size } = await $.fs.stat(path)
    if (size === eventsSize) return 0
    eventsSize = size
    text = await $.fs.read(path)
  } catch {
    return 0
  }
  const events = parseEvents(text).slice(activity.eventsSeen)
  if (events.length === 0) return 0
  const now = await $.clock.now()
  for (const event of events) {
    // tb-run --video: "● REC" no título do card enquanto grava (o card nunca sai cortado).
    if (event.phase === 'rec') {
      const base = (activity.intent ?? 'navegador').replace(/^● REC · /, '')
      activity.intent = event.label === 'on' ? `● REC · ${base}` : base
      continue
    }
    // tb-run: etapa nova (um roteiro da suíte, uma rodada do --repetir).
    if (event.phase === 'chapter') {
      activity.chapters.push(event.label || 'roteiro')
      continue
    }
    // tb-run: o roteiro anuncia cada passo antes de rodá-lo.
    if (event.phase === 'add') {
      const chapter = Math.max(0, activity.chapters.length - 1)
      const label = event.label || (event.check ? 'verificar' : 'passo')
      activity.steps = [...activity.steps, { label, status: 'next' as const, startedAt: now, ms: null, check: event.check, chapter }].slice(-STEPS_KEPT)
      advance(now)
      continue
    }
    const current = activity.steps.find(step => step.status === 'working')
    if (!current) break
    // Aviso de início: só dá nome ao passo que está rodando.
    if (event.phase === 'start') {
      if (event.target) current.label = relabel(current.label, event.target)
      continue
    }
    current.status = event.ok ? 'done' : 'failed'
    current.ms = now - current.startedAt
    if (event.target) current.label = relabel(current.label, event.target)
    advance(now)
  }
  activity.eventsSeen += events.length
  $.ui.invalidate('ui.render')
  return events.length
}

// Fim do comando Bash. Com eventos, o que sobrou sem evento não rodou (a
// cadeia parou numa falha) e sai do card; sem eventos (wrapper ausente), o
// comando inteiro conta: tudo feito, ou o último falhou.
async function endSteps($: EngineInterface, steps: Step[], failed: boolean, sawEvents: boolean): Promise<void> {
  const now = await $.clock.now()
  const pending = steps.filter(step => step.status === 'working' || step.status === 'next')
  if (sawEvents) {
    if (failed) activity.steps = activity.steps.filter(step => !pending.includes(step))
    else pending.forEach(step => { step.status = 'done'; step.ms = now - step.startedAt })
  } else {
    pending.forEach((step, i) => {
      step.status = failed && i === pending.length - 1 ? 'failed' : 'done'
      step.ms = now - step.startedAt
    })
  }
  $.ui.invalidate('ui.render')
}

// Card zerado: a próxima abertura não mostra passos nem rede da rodada velha.
function resetActivity(): void {
  activity.steps = []
  activity.startedAt = 0
  activity.finishedAt = null
  activity.intent = null
  activity.chapters = []
  activity.eventsSeen = 0
  net.requests = []
  net.console = []
}

// Limpa o log de rede e console do navegador (tb-net clear).
function clearBrowserLog($: EngineInterface): void {
  detach((async () => {
    const env = await scriptEnv($)
    await $.process.run([binPath($, 'tb-net'), 'clear'], { timeoutMs: 10_000, env }).catch(() => {})
  })())
}

async function finishActivity($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  activity.finishedAt = now
  $.ui.invalidate('ui.render')
  // Tela final na página, com os mesmos números do relatório do card.
  const steps = activity.steps
  const chapters = chaptersOf(steps, activity.chapters, now)
  const checks = steps.filter(step => step.check && (step.status === 'done' || step.status === 'failed'))
  const dir = await tbabDir($)
  if (dir) await $.fs.write(`${dir}/caption.txt`, '').catch(() => {})
  if (steps.length === 0) return
  pageScript($, 'endcard', {
    ok: !steps.some(step => step.status === 'failed'),
    etapas: chapters.length,
    acoes: steps.length,
    verificacoes: checks.length,
    verificacoesOk: checks.filter(step => step.status === 'done').length,
    tempo: formatMs(activeMs(steps, now)),
    // Falhas primeiro, com o passo que falhou, pra não sumirem da lista curta.
    capitulos: reportChapters(chapters, 5).map(chapter => ({
      titulo: chapter.title,
      ok: chapter.status !== 'failed',
      falhou: chapter.failedStep,
    })),
  })
}

// --- rede: o que a página pede, ao lado dos passos ---
//
// O ~/.local/bin/tb-net fala direto com o agent-browser (não acende o
// indicador de agente na aba nem gera evento) e devolve as últimas
// requisições e mensagens de console. Roda enquanto o painel está na tela:
// a cada 1,2 s com o agente trabalhando, a cada 4 s parado; com o painel
// escondido atrás de outro (ou esperando largura), não roda.

const net = {
  requests: [] as Req[],
  console: [] as ConsoleMsg[],
  polling: null as { cancel: () => void } | null,
  busy: false,
  lastAt: 0,
}

const NET_FAST_MS = 1200
const NET_IDLE_MS = 4000
// O card mostra no máximo isso de requisições: as props do card têm teto.
const NET_KEPT = 40

async function paneOnScreen($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
  } catch {
    return true
  }
}

async function pollNet($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  if (!home) return
  try {
    const env = await scriptEnv($)
    const ran = await $.process.run([binPath($, 'tb-net')], { timeoutMs: 8_000, env })
    const parsed = JSON.parse(ran.stdout.trim() || '{}') as { requests?: Req[]; console?: ConsoleMsg[] }
    const requests = Array.isArray(parsed.requests) ? parsed.requests.slice(-NET_KEPT) : []
    const messages = Array.isArray(parsed.console) ? parsed.console.slice(-NET_KEPT) : []
    const changed = JSON.stringify(requests) !== JSON.stringify(net.requests)
      || messages.length !== net.console.length
    net.requests = requests
    net.console = messages
    if (changed) $.ui.invalidate('ui.render')
  } catch {}
}

function startNetPolling($: EngineInterface): void {
  if (net.polling) return
  net.polling = $.clock.every(NET_FAST_MS, () => {
    if (net.busy) return
    net.busy = true
    detach((async () => {
      try {
        const now = await $.clock.now()
        const isActive = activity.steps.some(step => step.status === 'working' || step.status === 'next')
        if (!isActive && now - net.lastAt < NET_IDLE_MS) return
        if (!(await paneOnScreen($))) return
        await pollNet($)
        net.lastAt = await $.clock.now()
      } finally {
        net.busy = false
      }
    })())
  })
}

function stopNetPolling(): void {
  net.polling?.cancel()
  net.polling = null
  net.busy = false
  net.requests = []
  net.console = []
}

// Card recolhido: só título e barra (4 linhas com a borda); o navegador
// ganha o resto. Alterna pelo botão [−]/[+] no canto do título.
let cardCollapsed = false
function cardRows(): number {
  return cardCollapsed ? COLLAPSED_ROWS : STATUS_ROWS
}

// VS Code (ou outro editor) no painel: é lugar de trabalho, não teste.
const workspaceMode = () => isWorkspacePage(state.pendingUrl ?? state.last?.url ?? null, state.last?.title ?? '')

// Rótulos longos cortados: as props do card têm teto de tamanho.
const clipLabel = (text: string) => ([...text].length > 80 ? `${[...text].slice(0, 79).join('')}…` : text)

// O que o card (card.tsx) desenha. Só dados: o card anima sozinho.
// Fundo do painel e do card: opção `background` do plugin (ver plugin.json).
let background = BG

function cardProps(cols: number, now: number): CardProps {
  return {
    cols,
    background,
    rows: cardRows(),
    collapsed: cardCollapsed,
    now,
    url: state.last?.url ?? null,
    steps: activity.steps.map(step => ({ ...step, label: clipLabel(step.label) })),
    finishedAt: activity.finishedAt,
    intent: activity.intent === null ? null : clipLabel(activity.intent),
    chapters: activity.chapters.map(clipLabel),
    requests: net.requests.map(r => ({ ...r, u: r.u.slice(0, 300) })),
    console: net.console.map(c => ({ type: c.type, text: c.text.slice(0, 300) })),
  }
}

export const register: Register = (on, options) => {
  const agentToolEnabled = options.agentTool === true
  background = typeof options.background === 'string' && options.background.trim() ? options.background.trim() : BG

  // Sem o noun $.browser do plugin original: ele é de quem instalou o
  // terminal-browser, e dois plugins não podem criar o mesmo noun.

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    let surfaces: readonly string[] = []
    try {
      surfaces = await $.session.surfaces()
    } catch {}
    if (!surfaces.includes('terminal')) return r
    // Wrapper do plugin pros comandos do agente (visual na página e eventos do
    // card), pelo env do processo: vale pros Bash que o Claude Code abrir daqui
    // em diante, sem configurar o shell de quem instalou nem reescrever comando.
    await $.env.set('TERMINAL_BROWSER_AGENT', binPath($, 'tb-agent-browser')).catch(() => {})
    // Cópia de instalação pode vir sem o bit de execução (zip, cache).
    await $.process.run(['chmod', '+x', binPath($, 'tb-agent-browser'), binPath($, 'tb-net'), binPath($, 'tb-page-js')], { timeoutMs: 5_000 }).catch(() => {})
    await $.command.register({
      name: 'browser',
      description: 'Open a browser to the right',
      argumentHint: '[url]',
      immediate: true,
    }).catch(err => $.ui.log(`terminal-browser: /browser not registered: ${err}`))
    if (agentToolEnabled) {
      await $.tool.register({
        name: 'open',
        description: 'Open terminal-browser directly inside claude code. Control the open page with the terminal-browser action CLI.',
        inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The page to open, as a full url or a host name' } } },
      }).catch(err => $.ui.log(`terminal-browser: open tool not registered: ${err}`))
      await $.tool.register({ name: 'close', description: 'Close the terminal-browser pane.' }).catch(err => $.ui.log(`terminal-browser: close tool not registered: ${err}`))
    }
    return r
  })

  on('command.run', { command: 'browser' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close' || (!arg && state.open)) {
      await closeBrowser($)
      return { text: 'Closed terminal-browser' }
    }
    const opened = await openBrowser($, arg || null)
    return { text: opened.ok ? 'Opened terminal-browser' : opened.error }
  })

  on('tool.call', { tool: new RegExp(`^${OPEN_TOOL}$`) }, async ($, e) => {
    const url = (e as { url?: unknown }).url
    const opened = await openBrowser($, typeof url === 'string' ? url : null)
    if (!opened.ok) return { deny: `could not open the browser: ${opened.error}` }
    // A chave do navegador desta sessão: com outra sessão também de navegador
    // aberto, o CLI sem `--browser` recusa ("several browsers match").
    const key = await browserKey($)
    const hint = key ? ` (navegador ${key}; com mais de um navegador aberto, passe --browser ${key} antes do -- nos comandos action)` : ''
    return { result: [{ type: 'text', text: `opened ${opened.url}${hint}` }] }
  })

  on('tool.call', { tool: new RegExp(`^${CLOSE_TOOL}$`) }, async ($) => {
    const closed = await closeBrowser($)
    return { result: [{ type: 'text', text: closed ? 'browser pane closed' : 'no browser pane was open (maybe the user closed it?)' }] }
  })

  // Lê os comandos do agente que mexem no navegador e mostra cada passo na faixa.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const parsed = parseBrowserSteps(e.command)
    // O comando passa como o agente escreveu: reescrever aqui fazia o auto mode
    // recusar a chamada e alterava até texto que só cita o comando (um script
    // que edita este arquivo, por exemplo).
    if (parsed.length === 0 || workspaceMode()) return next(e)
    const planned = parsed.flatMap(p => (p.kind === 'step' ? [{ label: p.label, check: p.check }] : []))
    const finishes = parsed.some(p => p.kind === 'done')
    // tb-run: os passos chegam pelos eventos; o capítulo abre vazio.
    const scripted = parsed.some(p => p.kind === 'script')
    const tracked = planned.length > 0 || scripted
    const intent = typeof e.description === 'string' && e.description.trim() ? e.description.trim() : null
    const path = tracked ? await eventsPath($) : null
    if (path) {
      await eventsChain
      await $.fs.write(path, '').catch(() => {})
      activity.eventsSeen = 0
      eventsSize = -1
    }
    const begun = tracked ? await beginSteps($, planned, intent) : []
    const chapter = activity.chapters.length - 1
    let sawEvents = false
    activity.polling?.cancel()
    activity.polling = path
      ? $.clock.every(EVENTS_POLL_MS, () => {
          if (eventsPending) return
          detach(pollEvents($, path).then(n => { if (n > 0) sawEvents = true }))
        })
      : null
    const ran = await next(e)
    activity.polling?.cancel()
    activity.polling = null
    if (path && (await pollEvents($, path)) > 0) sawEvents = true
    const failed = ran.deny !== undefined || ran.isError === true
    // Os passos deste comando: os planejados e os que o roteiro anunciou.
    const steps = scripted ? activity.steps.filter(step => step.chapter >= chapter) : begun
    if (steps.length > 0) await endSteps($, steps, failed, sawEvents)
    if (finishes) await finishActivity($)
    return ran
  }).catch(($, e, next) => next(e)) // falha da faixa nunca bloqueia o Bash

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Box } = await $.ui.resolve(e)
      return <Box />
    }
    const { Box, Button, Client, Image } = await $.ui.resolve(e)
    const bodyRows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : Math.max(8, (e.viewport?.rows ?? 30) - 8)
    // Sem o estado da página ainda (abrindo, ou logo depois de um reload), não
    // dá pra saber se é workspace: o card espera, pra não piscar no VS Code.
    const showCard = state.last !== null && !workspaceMode()
    const rows = Math.max(1, bodyRows - (showCard ? cardRows() : 0))
    const cols = Math.max(1, e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 80))
    const now = await $.clock.now()
    if (showCard) startNetPolling($)
    else stopNetPolling()
    // Se o painel está sendo desenhado, ele está aberto (vale após um reload,
    // quando o módulo novo ainda não sabe disso).
    state.open = true
    reattach($)
    // Tamanho pelo quadro mais novo (é o que o blit seguinte vai mandar);
    // a figura, pela regra do pictureToDraw.
    const latest = state.frame
    const grid = latest ? imageGrid(latest, cols, rows) : null
    const frame = pictureToDraw(state)
    state.mounted = grid
    const toggleLabel = cardCollapsed ? '[+]' : '[−]'
    return (
      <Box flexDirection="column" width={cols} height={bodyRows} backgroundColor={background}>
        <Box flexDirection="column" width={cols} height={rows}>
          {frame && grid ? (
            <Image key={IMAGE_KEY} source={imageSource(frame)} columns={grid.cols} rows={grid.rows} alt={IMAGE_ALT} />
          ) : null}
          <Box position="absolute" top={0} left={0} width={cols} height={rows}>
            <Client key={viewKey()} module="./surface.tsx" width={cols} height={rows} />
          </Box>
        </Box>
        {showCard && (<Box flexDirection="column" width={cols} height={cardRows()}>
          <Client key="card" module="./card.tsx" width={cols} height={cardRows()} props={cardProps(cols, now)} />
          {/* Botão de recolher por cima do canto do título (o card deixa o espaço). */}
          <Box position="absolute" top={1} left={Math.max(0, cols - 2 - (TOGGLE_ROOM - 1))} width={TOGGLE_ROOM - 1} height={1}>
            <Button
              key="toggle"
              label={toggleLabel}
              plain
              dimColor
              onPress={() => {
                cardCollapsed = !cardCollapsed
                $.ui.invalidate('ui.render')
              }}
            />
          </Box>
        </Box>)}
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || state.port === null) return next(e)
    if (isSizeMessage(e.data)) {
      state.region = { cols: e.data.cols, rows: e.data.rows }
      if (state.pendingUrl) {
        const url = state.pendingUrl
        state.pendingUrl = null
        state.reshow = false
        await post($, '/open', { url, ...state.region })
      } else if (state.reshow) {
        // Reaberto: /open sem url só reenvia tamanho e "visível", e a ponte
        // manda um quadro novo; com /size do mesmo tamanho a tela ficava vazia.
        state.reshow = false
        await post($, '/open', { ...state.region })
      } else {
        await post($, '/size', state.region)
      }
    } else if (isInputMessage(e.data)) {
      await post($, '/input', { events: e.data.events })
    }
    return next(e)
  })

  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    if (state.port === null || !state.open || e.by === 0) return {}
    const kind = e.by < 0 ? 'scrollup' : 'scrolldown'
    const ticks = Math.min(Math.round(Math.abs(e.by)) || 1, 10)
    const x = e.pointer?.column ?? Math.floor((state.region?.cols ?? 0) / 2)
    const y = e.pointer?.row ?? Math.floor((state.region?.rows ?? 0) / 2)
    const events = Array.from({ length: ticks }, () => ({ type: 'mouse', kind, x, y }))
    await post($, '/input', { events })
    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    await browserClosed($)
    return r
  })
}
