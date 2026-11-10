import type { EngineInterface, Register } from 'claude-code'

import { commandCwd, parseDiagnostics, type Diag, type DiagSource } from './diagnostics.ts'
import { searchHits, shellReads, shellSearch } from './reading.ts'

// O VS Code web (code serve-web, CLI oficial da Microsoft) sobe sob demanda
// pelo /vscode, só em 127.0.0.1 e com token. Um servidor atende todos os
// terminais: cada um abre a página na pasta da própria sessão. Daqui saem
// pra ponte só caminhos, linhas e trechos alterados; nunca saída de comando.
const PORT = 8765
const OPEN_TOOL = 'mcp__navegador__open'
const EXTENSION_ID = 'oscar.claude-live'
const START_WAIT_MS = 15_000
const START_POLL_MS = 500

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
type WriteLike = {
  filePath?: string
  structuredPatch?: Hunk[]
  type?: 'create' | 'update'
  content?: string
  staged?: boolean
}
type Range = { start: number; end: number }
// Todo evento leva a sessão, o nome dela no Elo (`name`, ou ausente sem Elo)
// e o subagente que agiu (`agent`, ausente na conversa principal).
type EventBase = { seq: number; session: string; name?: string; agent?: string }
type BridgeEvent = EventBase &
  (
    | { type: 'start'; path: string; at: number }
    | { type: 'end'; path: string; at: number; ok: boolean; ranges: Range[]; adds: number; dels: number; hunks?: Hunk[]; created?: boolean }
    | { type: 'read'; path: string; start: number; end: number }
    | { type: 'search'; pattern: string; path?: string }
    | { type: 'diagnostics'; source: DiagSource; items: Diag[] }
    | { type: 'hits'; pattern: string; files: { file: string; line?: number }[] }
  )
type ReadLike = { type?: string; file?: { filePath?: string; startLine?: number; numLines?: number } }
type BashLike = { stdout?: string; stderr?: string; interrupted?: boolean }

// O nome desta sessão no Elo ("Nilumi"), perguntado uma vez ao `elo name`.
let cachedName: string | null | undefined
async function eloName($: EngineInterface, session: string): Promise<string | undefined> {
  if (cachedName !== undefined) return cachedName ?? undefined
  try {
    const ran = await $.process.run(['elo', 'name'], { timeoutMs: 5_000, env: { CLAUDE_CODE_SESSION_ID: session } })
    const name = ran.exitCode === 0 ? ran.stdout.trim().replace(/^@/, '') : ''
    cachedName = /^[\p{L}\p{N}_-]{1,40}$/u.test(name) ? name : null
  } catch {
    cachedName = null
  }
  return cachedName ?? undefined
}

const agentNames = new Map<string, string>()

async function agentLabel($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return undefined
  const known = agentNames.get(agentId)
  if (known !== undefined) return known
  const agents = await $.agent.list().catch(() => [])
  const found = agents.find(agent => agent.id === agentId)
  const label = found?.name ?? (found?.description || found?.type) ?? `agente ${agentId.slice(0, 6)}`
  agentNames.set(agentId, label)
  return label
}

type Paths = {
  home: string
  code: string
  token: string
  data: string
  log: string
  /** pasta com um arquivo de eventos por sessão */
  bridges: string
  /** pasta com um arquivo de pedidos do VS Code por sessão */
  inbox: string
  /** workspaces da versão antiga, só pra apagar no fim da sessão */
  workspaces: string
  /** vínculo janela → sessão: <pasta>.json, e live-<sessão> enquanto aberta */
  windows: string
}

// Guardados na primeira leitura: o hook de edição não espera por eles de novo.
let cachedPaths: Paths | undefined
let cachedSession: string | undefined
const sessionIdOf = async ($: EngineInterface) => (cachedSession ??= await $.session.id())

async function pathsOf($: EngineInterface): Promise<Paths | undefined> {
  if (cachedPaths !== undefined) return cachedPaths
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const cli = `${home}/.local/share/vscode-cli`
  cachedPaths = {
    home,
    code: `${cli}/code`,
    token: `${cli}/token`,
    data: `${cli}/server-data`,
    log: `${cli}/serve-web.log`,
    bridges: `${home}/.claude/claude-live/bridge`,
    inbox: `${home}/.claude/claude-live/inbox`,
    workspaces: `${home}/.claude/claude-live/workspaces`,
    windows: `${home}/.claude/claude-live/windows`,
  }
  return cachedPaths
}

// ---------- ponte com a extensão Claude Live ----------

const bridgeEvents: BridgeEvent[] = []
let bridgeQueue: Promise<void> = Promise.resolve()
let seqCounter = 0
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000)

function emit($: EngineInterface, file: string, ev: BridgeEvent): void {
  bridgeEvents.push(ev)
  if (bridgeEvents.length > 40) bridgeEvents.splice(0, bridgeEvents.length - 40)
  const snapshot = JSON.stringify({ events: bridgeEvents })
  bridgeQueue = bridgeQueue.then(() => $.fs.write(file, snapshot)).catch(() => undefined)
}

// Linhas (1-based, no arquivo novo) que a edição acrescentou ou trocou.
export function addedRanges(hunks: Hunk[]): Range[] {
  const out: Range[] = []
  for (const h of hunks) {
    let line = h.newStart
    for (const text of h.lines) {
      if (text.startsWith('-')) continue
      if (text.startsWith('+')) {
        const prev = out[out.length - 1]
        if (prev && prev.end === line - 1) prev.end = line
        else out.push({ start: line, end: line })
      }
      line++
    }
  }
  return out
}

// Os trechos alterados que vão no fim da edição: com eles a extensão
// reconstrói o "antes" do diff desfazendo a edição no texto atual, sem
// depender de ler o arquivo antes da escrita (que às vezes já mudou e deixava
// o diff vazio). Arquivo novo vai como `created`: o "antes" é vazio.
// Teto de linhas por evento: edição maior que isso fica sem "antes"
// reconstruído (o diff mostra o que a extensão leu).
const HUNK_LINES_MAX = 2000
export function hunksOf(result: WriteLike): { hunks?: Hunk[]; created?: boolean } {
  if (result.type === 'create') return { created: true }
  const hunks = result.structuredPatch ?? []
  const lines = hunks.reduce((sum, h) => sum + h.lines.length, 0)
  return hunks.length > 0 && lines <= HUNK_LINES_MAX ? { hunks } : {}
}

// Linhas acrescentadas e removidas, pros "+12 −3" do VS Code.
export function countsOf(result: WriteLike): { adds: number; dels: number } {
  if (result.structuredPatch && result.structuredPatch.length > 0) {
    let adds = 0
    let dels = 0
    for (const hunk of result.structuredPatch) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) adds++
        else if (line.startsWith('-')) dels++
      }
    }
    return { adds, dels }
  }
  if (result.type === 'create' && result.content !== undefined) {
    return { adds: result.content.split('\n').length - (result.content.endsWith('\n') ? 1 : 0), dels: 0 }
  }
  return { adds: 0, dels: 0 }
}

function rangesOf(result: WriteLike): Range[] {
  if (result.structuredPatch && result.structuredPatch.length > 0) return addedRanges(result.structuredPatch)
  if (result.type === 'create' && result.content !== undefined) {
    const count = result.content.split('\n').length - (result.content.endsWith('\n') ? 1 : 0)
    return count > 0 ? [{ start: 1, end: count }] : []
  }
  return []
}

// ---------- servidor ----------

async function isUp($: EngineInterface): Promise<boolean> {
  try {
    await $.http.fetch(`http://127.0.0.1:${PORT}/`)
    return true
  } catch {
    return false
  }
}

const randomToken = () =>
  [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('')

type RegistryEntry = { identifier?: { id?: string } }

// Caminhos relativos de todos os arquivos sob `dir`.
async function filesUnder($: EngineInterface, dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await $.fs.list(`${dir}${prefix ? `/${prefix}` : ''}`)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'file') out.push(rel)
    else if (entry.kind === 'dir') out.push(...(await filesUnder($, dir, rel)))
  }
  return out
}

// Copia a extensão do mod pro servidor quando falta ou mudou, apaga as
// versões antigas e registra a nova no extensions.json: o servidor só carrega
// a versão que está lá. Uma janela já aberta pega a nova ao recarregar.
async function installExtension($: EngineInterface, p: Paths): Promise<boolean> {
  const source = `${$.plugin.root}/vscode-extension`
  const manifest = await $.fs.read(`${source}/package.json`)
  const version = (JSON.parse(manifest) as { version: string }).version
  const extensions = `${p.data}/extensions`
  const folder = `${EXTENSION_ID}-${version}`
  const target = `${extensions}/${folder}`
  // Todos os arquivos da extensão (código, ícones): copia só se algum mudou.
  const files = await filesUnder($, source)
  const contents = await Promise.all(files.map(file => $.fs.read(`${source}/${file}`)))
  const installed = await Promise.all(files.map(file => $.fs.read(`${target}/${file}`).catch(() => undefined)))
  if (installed.every((text, i) => text === contents[i])) return false

  for (const [i, file] of files.entries()) await $.fs.write(`${target}/${file}`, contents[i] ?? '')

  const entries = await $.fs.list(extensions).catch(() => [])
  for (const entry of entries) {
    if (entry.kind === 'dir' && entry.name.startsWith(`${EXTENSION_ID}-`) && entry.name !== folder) {
      await $.process.run(['rm', '-rf', `${extensions}/${entry.name}`], { timeoutMs: 10_000 })
    }
  }

  const registryPath = `${extensions}/extensions.json`
  const registry = JSON.parse(await $.fs.read(registryPath).catch(() => '[]')) as RegistryEntry[]
  const others = registry.filter(item => item.identifier?.id?.toLowerCase() !== EXTENSION_ID)
  const mine = {
    identifier: { id: EXTENSION_ID },
    version,
    location: { $mid: 1, path: target, scheme: 'file' },
    relativeLocation: folder,
  }
  await $.fs.write(registryPath, JSON.stringify([...others, mine]))
  return true
}

// `folder`: a pasta que o /vscode está abrindo, também a padrão do servidor
// (nada fixo: cada pessoa trabalha numa pasta).
async function startServer($: EngineInterface, p: Paths, folder: string): Promise<string | undefined> {
  if (!(await $.fs.exists(p.code))) {
    return `A CLI do VS Code não está em ${p.code}. Baixe em https://code.visualstudio.com/download (CLI, macOS) e descompacte lá.`
  }
  if (!(await $.fs.exists(p.token))) await $.fs.write(p.token, randomToken())
  // sh -c com nohup: o servidor não pertence a esta sessão e continua no ar
  // pros outros terminais quando ela fecha.
  await $.process.run(
    [
      '/bin/sh',
      '-c',
      'nohup "$0" serve-web --host 127.0.0.1 --port "$1" --connection-token-file "$2" --accept-server-license-terms --server-data-dir "$3" --default-folder "$4" --disable-telemetry >>"$5" 2>&1 &',
      p.code,
      String(PORT),
      p.token,
      p.data,
      folder,
      p.log,
    ],
    { timeoutMs: 10_000 },
  )
  for (let waited = 0; waited < START_WAIT_MS; waited += START_POLL_MS) {
    if (await isUp($)) return undefined
    await $.clock.sleep(START_POLL_MS)
  }
  return `O VS Code não respondeu em ${START_WAIT_MS / 1000} s. Log: ${p.log}`
}

async function stopServer($: EngineInterface): Promise<boolean> {
  const ran = await $.process.run(['pkill', '-f', `serve-web --host 127.0.0.1 --port ${PORT}`], { timeoutMs: 5_000 })
  return ran.exitCode === 0
}

// O VS Code abre a pasta direto (?folder=): o mesmo endereço de sempre, e a
// pergunta "confia nos autores?" do VS Code, já respondida pra pasta, não
// volta. (Um workspace novo por sessão fazia ela voltar a cada sessão.) Qual
// sessão é dona da janela vai num arquivo à parte, que a extensão lê ao
// carregar e guarda pra aquela janela; o marcador live-<sessão> diz que esta
// sessão abriu o VS Code (sem ele, nada vai pro disco).
export const windowKey = (folder: string) => encodeURIComponent(folder)

async function bindWindow($: EngineInterface, p: Paths, folder: string): Promise<void> {
  const session = await sessionIdOf($)
  await $.fs.write(`${p.windows}/${windowKey(folder)}.json`, JSON.stringify({ session, sessionFolder: folder, at: Date.now() }))
  await $.fs.write(`${p.windows}/live-${session}`, folder)
}

async function openPane($: EngineInterface, p: Paths, folder: string): Promise<string | undefined> {
  const token = (await $.fs.read(p.token)).trim()
  await bindWindow($, p, folder)
  const url = `http://127.0.0.1:${PORT}/?tkn=${token}&folder=${encodeURIComponent(folder)}`
  const opened = await $.tool.call({ tool: OPEN_TOOL, url }).catch(() => undefined)
  if (opened !== undefined && !('deny' in opened && opened.deny !== undefined)) return undefined
  const ran = await $.command.run({ command: 'browser', args: url }).catch(() => undefined)
  return ran === undefined ? 'Não consegui abrir o painel: o plugin navegador está instalado?' : undefined
}

const resolveFolder = (root: string, arg: string) => {
  if (arg === '') return root
  if (arg.startsWith('/')) return arg
  return `${root.replace(/\/+$/, '')}/${arg}`
}

// ---------- só com o VS Code desta sessão aberto ----------
// A ponte leva os trechos que o Claude lê e edita: nada disso vai pro
// disco numa sessão que não abriu o VS Code (/vscode). O sinal é o marcador
// live-<sessão>, que o /vscode grava; a resposta "não" vale 5 s, a "sim" fica.
let liveCache: { value: boolean; at: number } | undefined
async function isLive($: EngineInterface, p: Paths): Promise<boolean> {
  if (liveCache?.value) return true
  if (liveCache && Date.now() - liveCache.at < 5_000) return false
  const value = await $.fs.exists(`${p.windows}/live-${await sessionIdOf($)}`).catch(() => false)
  liveCache = { value, at: Date.now() }
  return value
}

// ---------- pedidos do VS Code ("Perguntar ao Claude") ----------

type InboxRequest = { seq: number; text: string }
// Teto do texto que um pedido põe na caixa de digitação.
const INBOX_TEXT_MAX = 12_000
// A caixa de entrada do "Perguntar ao Claude" é conferida a cada meio segundo:
// rápido o bastante pra parecer imediato, leve o bastante pra não pesar.
const INBOX_POLL_MS = 500
let inboxSeen = -1
let inboxMtime = -1
let inboxBusy = false

// O VS Code grava pedidos em inbox/<sessão>.json; aqui viram texto na caixa
// de digitação do Claude Code, e a pessoa lê e aperta Enter. Nunca um envio
// automático: qualquer programa do usuário pode escrever nesse arquivo, e um
// prompt mandado sozinho, em nome da pessoa, seria uma porta pra injeção.
// Na primeira olhada só marca até onde já foi, pra não repetir pedidos.
async function pollInbox($: EngineInterface): Promise<void> {
  if (inboxBusy) return
  inboxBusy = true
  try {
    const p = await pathsOf($)
    if (p === undefined || !(await isLive($, p))) return
    const file = `${p.inbox}/${await sessionIdOf($)}.json`
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (stat === undefined) {
      if (inboxSeen < 0) inboxSeen = 0
      return
    }
    if (stat.mtimeMs === inboxMtime) return
    const parsed = JSON.parse(await $.fs.read(file)) as { requests?: InboxRequest[] }
    inboxMtime = stat.mtimeMs
    const requests = (parsed.requests ?? []).filter(r => typeof r.seq === 'number' && typeof r.text === 'string')
    if (inboxSeen < 0) {
      inboxSeen = Math.max(0, ...requests.map(r => r.seq))
      return
    }
    for (const request of requests.filter(r => r.seq > inboxSeen).sort((a, b) => a.seq - b.seq)) {
      inboxSeen = request.seq
      const text = request.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, INBOX_TEXT_MAX)
      if (text.trim() !== '') await $.prompt.fill({ text, mode: 'append' })
    }
  } catch {
    // Arquivo pela metade: a próxima volta lê de novo.
  } finally {
    inboxBusy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vscode',
      description: 'Abre o VS Code no painel, na pasta desta sessão (sobe o servidor se preciso)',
      argumentHint: '[pasta | stop]',
    })
    $.clock.every(INBOX_POLL_MS, () => void pollInbox($))

    return next(e)
  })

  // Fim da sessão: apaga a ponte (caminhos e trechos lidos e editados), os
  // pedidos, o marcador de janela aberta e o workspace dela. Nada da sessão
  // fica no disco depois.
  on('session.end', async ($, e, next) => {
    const p = await pathsOf($)
    if (p !== undefined) {
      const files = [
        `${p.bridges}/${e.sessionId}.json`,
        `${p.inbox}/${e.sessionId}.json`,
        `${p.windows}/live-${e.sessionId}`,
        `${p.workspaces}/${e.sessionId}.code-workspace`,
      ]
      await $.process.run(['rm', '-f', ...files], { timeoutMs: 3_000 }).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'vscode' }, async ($, e) => {
    const p = await pathsOf($)
    if (p === undefined) return { text: 'Sem HOME no ambiente: não sei onde fica o VS Code.' }
    const arg = e.args.trim()

    if (arg === 'stop') {
      return { text: (await stopServer($)) ? 'VS Code desligado.' : 'O VS Code já estava desligado.' }
    }

    const folder = resolveFolder(await $.session.root(), arg)
    if (!(await $.fs.exists(folder))) return { text: `Pasta não encontrada: ${folder}` }

    const isNewExtension = await installExtension($, p).catch(() => false)
    const wasUp = await isUp($)
    if (!wasUp) {
      const failed = await startServer($, p, folder)
      if (failed !== undefined) return { text: failed }
    }
    const failed = await openPane($, p, folder)
    if (failed !== undefined) return { text: failed }
    liveCache = { value: true, at: Date.now() }
    // Ponte e pedidos ficam numa pasta que só o seu usuário lê.
    await $.process.run(['chmod', '700', `${p.home}/.claude/claude-live`], { timeoutMs: 5_000 }).catch(() => undefined)

    const how = wasUp ? 'reaproveitei o servidor que já estava no ar' : 'subi o servidor'
    const note = isNewExtension && wasUp ? ' A extensão mudou: recarregue a página do VS Code (cmd+r) pra pegar.' : ''
    return { text: `VS Code aberto em ${folder} (${how}).${note}` }
  })

  // Cada ferramenta que o VS Code sabe mostrar vira eventos na ponte desta
  // sessão: escrita (início e fim, com as linhas mudadas), leitura (as linhas
  // lidas) e busca (o padrão). Comandos não: a conversa já mostra.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isWrite = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit'
    const isShown = isWrite || tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'Bash'
    const p = isShown ? await pathsOf($) : undefined
    if (p === undefined || !(await isLive($, p))) return next(e)

    const input = e as unknown as {
      file_path?: string
      notebook_path?: string
      pattern?: string
      path?: string
      agentId?: string
      tool_use_id: string
    }
    const session = await sessionIdOf($)
    const base = {
      session,
      name: await eloName($, session),
      agent: await agentLabel($, input.agentId),
    }
    // Um arquivo por sessão: duas sessões gravando juntas não apagam o
    // evento uma da outra antes de o VS Code ler.
    const bridge = `${p.bridges}/${session}.json`
    const isFailed = (ran: object) =>
      ('deny' in ran && (ran as { deny?: string }).deny !== undefined) || ('isError' in ran && (ran as { isError?: boolean }).isError === true)

    if (tool === 'Grep' || tool === 'Glob') {
      if (input.pattern) emit($, bridge, { ...base, seq: nextSeq(), type: 'search', pattern: input.pattern, path: input.path })
      return next(e)
    }

    // Comando: só os problemas de typecheck, lint e testes (arquivo, linha,
    // mensagem) vão pra ponte, nunca a saída. Uma ferramenta que rodou limpa
    // apaga as marcações dela; uma que falhou sem problema reconhecível não.
    if (tool === 'Bash') {
      const command = (e as unknown as { command?: string }).command ?? ''
      const cwd = commandCwd(command, await $.session.cwd(), p.home)
      // Leitura e busca pelo terminal (sed -n, head, cat, rg, grep): avisadas
      // quando o comando começa, pra aparecer antes do resultado.
      for (const read of shellReads(command, cwd, p.home)) {
        if (await $.fs.exists(read.file).catch(() => false)) {
          emit($, bridge, { ...base, seq: nextSeq(), type: 'read', path: read.file, start: read.start, end: read.end })
        }
      }
      const pattern = shellSearch(command)
      if (pattern) emit($, bridge, { ...base, seq: nextSeq(), type: 'search', pattern })

      const ran = await next(e)
      const result = ((ran as { result?: unknown }).result ?? {}) as BashLike
      const ok = !isFailed(ran) && !result.interrupted
      // Comando que falhou (saída diferente de 0) vem como texto de erro, sem
      // stdout/stderr: lê os três, e o leitor tira as repetições.
      const text = (ran as { text?: string }).text ?? ''
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${text}`
      // Os arquivos que a busca achou (só os que existem): acendem no Explorer.
      if (pattern) {
        const files = []
        for (const hit of searchHits(output, cwd, p.home)) {
          if (await $.fs.exists(hit.file).catch(() => false)) files.push(hit)
        }
        if (files.length > 0) emit($, bridge, { ...base, seq: nextSeq(), type: 'hits', pattern, files })
      }
      const found = parseDiagnostics(command, output, cwd, p.home)
      for (const [source, items] of found) {
        if (items.length === 0 && !ok) continue
        emit($, bridge, { ...base, seq: nextSeq(), type: 'diagnostics', source, items })
      }
      return ran
    }

    if (tool === 'Read') {
      const ran = await next(e)
      const file = (((ran as { result?: unknown }).result ?? {}) as ReadLike).file
      if (!isFailed(ran) && file?.filePath && file.startLine !== undefined && file.numLines) {
        const end = file.startLine + file.numLines - 1
        emit($, bridge, { ...base, seq: nextSeq(), type: 'read', path: file.filePath, start: file.startLine, end })
      }
      return ran
    }

    const target = input.file_path ?? input.notebook_path
    if (target === undefined) return next(e)
    emit($, bridge, { ...base, seq: nextSeq(), type: 'start', path: target, at: Date.now() })
    const ran = await next(e)
    const result = ((ran as { result?: unknown }).result ?? {}) as WriteLike
    const ok = !isFailed(ran) && !result.staged
    emit($, bridge, {
      ...base,
      seq: nextSeq(),
      type: 'end',
      path: result.filePath ?? target,
      at: Date.now(),
      ok,
      ranges: ok ? rangesOf(result) : [],
      ...(ok ? countsOf(result) : { adds: 0, dels: 0 }),
      // Os trechos alterados: a extensão reconstrói o "antes" do diff com eles,
      // sem depender de ler o arquivo antes da escrita (que às vezes já mudou).
      ...(ok ? hunksOf(result) : {}),
    })

    return ran
  }).catch(($, e, next) => next(e)) // a ponte nunca atrapalha uma ferramenta
}
