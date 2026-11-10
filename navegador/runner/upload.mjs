// --enviar do tb-run: manda a evidência pro Worker das evidências e devolve o
// link curto (<EVIDENCE_URL>/e/<uuid>).
//
// 1. POST /api/runs (Bearer EVIDENCE_TOKEN) com o resumo e a lista de arquivos
//    → o Worker cria o uuid e devolve um link de upload assinado por arquivo;
// 2. cada arquivo sobe direto pro Supabase por esse link (o vídeo não passa pelo Worker);
// 3. POST /api/runs/<uuid>/complete → o Worker confere o manifest e libera o link.
//
// Nenhuma chave do Supabase na máquina: o token só cria evidência. Config em
// ~/.config/navegador/evidencias.env (ou no ambiente):
//   EVIDENCE_URL=https://evidencias-e2e.<conta>.workers.dev
//   EVIDENCE_TOKEN=<o mesmo valor do secret UPLOAD_TOKEN do Worker>

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = path.join(os.homedir(), '.config', 'navegador')
const CONFIG_FILE = path.join(DIR, 'evidencias.env')
const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' }

function readEnvFile(file) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return out
}

export function loadConfig() {
  const file = readEnvFile(CONFIG_FILE)
  const get = k => process.env[k] || file[k] || ''
  const cfg = { url: (get('EVIDENCE_URL') || get('EVIDENCE_VIEWER_URL')).replace(/\/+$/, ''), token: get('EVIDENCE_TOKEN') }
  const missing = [!cfg.url && 'EVIDENCE_URL', !cfg.token && 'EVIDENCE_TOKEN'].filter(Boolean)
  if (missing.length) throw new Error(`falta ${missing.join(' e ')} em ${CONFIG_FILE}`)
  if (!/^https:\/\//.test(cfg.url) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(cfg.url)) throw new Error(`EVIDENCE_URL tem de ser https:// (veio ${cfg.url})`)
  return cfg
}

async function api(cfg, route, body) {
  const res = await fetch(`${cfg.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body ?? {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const why = res.status === 401 ? 'token recusado (EVIDENCE_TOKEN diferente do UPLOAD_TOKEN do Worker?)'
      : res.status === 503 ? 'Worker sem configuração (secret SUPABASE_SECRET_KEY)'
      : `${data.error ?? 'erro'}${data.detail ? ` (${data.detail})` : ''}`
    throw Object.assign(new Error(`${route} → ${res.status}: ${why}`), { status: res.status })
  }
  return data
}

async function pool(items, size, fn) {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift())
  }))
}

/**
 * Manda a pasta do relatório e devolve { link, id, expiresAt, notes }.
 * summary: { title, project, passed, steps, checks, durationMs }
 */
export async function uploadEvidence(reportDir, summary) {
  const cfg = loadConfig()
  const rels = fs.readdirSync(reportDir, { recursive: true }).map(String)
    .filter(p => TYPES[path.extname(p).toLowerCase()] && !p.endsWith('manifest.json'))
    .map(p => p.split(path.sep).join('/'))
  const html = fs.readFileSync(path.join(reportDir, 'index.html'), 'utf8')
  const sizes = Object.fromEntries(rels.map(r => [r, fs.statSync(path.join(reportDir, r)).size]))

  const created = await api(cfg, '/api/runs', {
    ...summary,
    files: [...rels.map(r => ({ path: r, size: sizes[r] })), { path: 'manifest.json', size: html.length }],
  })
  const manifest = Buffer.from(JSON.stringify({ version: 2, id: created.id, title: summary.title, passed: summary.passed, createdAt: new Date().toISOString(), html, files: rels }))

  const put = async (rel, body) => {
    const up = created.uploads[rel]
    if (!up) throw new Error(`o Worker não devolveu link de upload pra ${rel}`)
    const res = await fetch(up.url, { method: 'PUT', headers: { 'content-type': up.type ?? TYPES[path.extname(rel)], 'x-upsert': 'true' }, body })
    if (!res.ok) throw new Error(`upload de ${rel} → ${res.status}: ${(await res.text()).slice(0, 160)}`)
  }
  await pool(rels, 4, rel => put(rel, fs.readFileSync(path.join(reportDir, rel))))
  await put('manifest.json', manifest)

  const done = await api(cfg, `/api/runs/${created.id}/complete`)
  return { link: done.link, id: created.id, expiresAt: done.expiresAt, notes: [] }
}
