// tb-record: grava o que a pessoa faz no navegador do painel e gera um
// roteiro do tb-run. Ela clica e digita normalmente; ao clicar em "parar" no
// selo (ou com Ctrl+C / SIGTERM / --segundos), o roteiro sai em arquivo e no
// stdout, pronto pra editar (falta só pôr as verificações).
//
// Uso: tb-record [--saida arquivo.mjs] [--segundos N] [--browser <chave>]
// Sem --saida: ~/.tbab/<navegador>/gravacoes/<data>.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, shortError } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const opts = { out: null, seconds: 0, browser: process.env.TB_KEY || null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--saida' || a === '--out') opts.out = argv[++i]
    else if (a === '--segundos' || a === '--seconds') opts.seconds = Number(argv[++i])
    else if (a === '--browser') opts.browser = argv[++i]
    else if (a === '-h' || a === '--help') opts.help = true
  }
  return opts
}

const q = s => JSON.stringify(String(s))

function locatorCode(t) {
  switch (t.by) {
    case 'label': return `page.getByLabel(${q(t.value)})`
    case 'placeholder': return `page.getByPlaceholder(${q(t.value)})`
    case 'role': return `page.getByRole(${q(t.role)}, { name: ${q(t.name)} })`
    case 'testid': return `page.getByTestId(${q(t.value)})`
    case 'text': return `page.getByText(${q(t.value)})`
    default: return `page.locator(${q(t.value)})`
  }
}

const sameTarget = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Ações em linhas de código; fill seguido no mesmo campo vira um só.
function toCode(actions) {
  const merged = []
  for (const a of actions) {
    const prev = merged.at(-1)
    if (a.type === 'fill' && prev?.type === 'fill' && sameTarget(prev.target, a.target)) { merged[merged.length - 1] = a; continue }
    if (a.type === 'goto' && prev?.type === 'goto') { merged[merged.length - 1] = a; continue }
    merged.push(a)
  }
  const lines = []
  for (const a of merged) {
    if (a.type === 'goto') lines.push(`  await goto(${q(a.url)})`)
    else if (a.type === 'nav') lines.push(`  // foi para ${a.url}`)
    else if (a.type === 'click') lines.push(`  await click(${locatorCode(a.target)})`)
    else if (a.type === 'fill') {
      lines.push(a.secret
        ? `  await fill(${locatorCode(a.target)}, process.env.SENHA ?? '') // senha não é gravada: SENHA=… tb-run …`
        : `  await fill(${locatorCode(a.target)}, ${q(a.value)})`)
    } else if (a.type === 'select') lines.push(`  await select(${locatorCode(a.target)}, ${JSON.stringify(a.value)})`)
    else if (a.type === 'press') lines.push(`  await press(${q(a.key)})`)
  }
  return lines
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('uso: tb-record [--saida arquivo.mjs] [--segundos N] [--browser <chave>]\n  grava cliques, preenchimentos, seleções e Enter no painel; para no botão "parar" do selo, com Ctrl+C ou após N segundos')
    process.exit(0)
  }
  const { page, dir } = await connect(opts.browser)
  const recorder = fs.readFileSync(path.join(here, 'recorder.js'), 'utf8')
  const actions = [{ type: 'goto', url: page.url() }]
  let lastActionAt = 0
  let done
  const finished = new Promise(r => { done = r })

  await page.exposeBinding('__tbRec', async (_src, ev) => {
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'stop') return done('botão parar')
    if (!['click', 'fill', 'select', 'press'].includes(ev.type)) return
    actions.push(ev)
    lastActionAt = Date.now()
    const count = actions.filter(a => a.type !== 'goto' && a.type !== 'nav').length
    await page.evaluate(n => window.__tbRecCounted?.(n), count).catch(() => {})
  })
  // Navegação que não veio de clique/Enter (barra de endereço, redirect lento) vira goto.
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return
    const url = frame.url()
    if (!/^https?:/.test(url)) return
    actions.push(Date.now() - lastActionAt < 3_000 ? { type: 'nav', url } : { type: 'goto', url })
  })
  await page.context().addInitScript(recorder)
  await page.evaluate(recorder)

  process.on('SIGINT', () => done('Ctrl+C'))
  process.on('SIGTERM', () => done('SIGTERM'))
  if (opts.seconds > 0) setTimeout(() => done(`${opts.seconds}s`), opts.seconds * 1000)
  console.error('gravando: faça o fluxo no painel e clique em "parar" no selo vermelho (ou Ctrl+C)')
  const why = await finished

  // Tira o selo e desliga a escuta nesta página (o init script morre com a conexão).
  await page.evaluate(() => { document.getElementById('__ag_rec')?.remove(); window.__tbRec = () => {} }).catch(() => {})

  // "foi para" no fim não diz nada.
  while (actions.at(-1)?.type === 'nav') actions.pop()
  const body = toCode(actions)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = path.resolve(opts.out ?? path.join(dir, 'gravacoes', `${stamp}.mjs`))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const code = `// Gravado com tb-record em ${new Date().toLocaleString('pt-BR')}.
// Falta pôr as verificações (see, check, api) nos pontos que importam.
export default async ({ page, goto, click, fill, select, press, see, check, api }) => {
${body.join('\n')}
}
`
  fs.writeFileSync(out, code)
  const n = actions.filter(a => !['goto', 'nav'].includes(a.type)).length
  console.log(`✓ gravação parada (${why}) · ${n} ações · ${out}\n\n${code}`)
  process.exit(0)
}

main().catch(err => {
  console.log(`✗ tb-record: ${shortError(err)}`)
  process.exit(2)
})
