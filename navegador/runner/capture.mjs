// Rede e console completos de uma execução do tb-run, pro relatório (estilo
// Jam/DevTools): cada requisição com tempo relativo ao vídeo, cabeçalhos,
// payload e resposta (de API). O relatório vai pra outras pessoas, então segredo sai
// mascarado (cabeçalhos de credencial, campos de senha/token/CPF/cartão no
// corpo e na query string).

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$|token|secret|session|api[-_]?key|password/i
const SECRET_KEY = /pass(word)?|senha|token|secret|authorization|api[-_]?key|cpf|cnpj|cvv|cvc|card|cart[aã]o|credit|session|cookie|otp|pin$/i
const HIDDEN = '•••'
const BODY_MAX = 6_000
const BODY_TOTAL_MAX = 3_000_000
const TEXTUAL = /json|text|xml|javascript|x-www-form-urlencoded|graphql/i

function redactHeaders(h = {}) {
  const out = {}
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADER.test(k) ? HIDDEN : String(v)
  return out
}

function redactValue(v) {
  if (Array.isArray(v)) return v.map(redactValue)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? HIDDEN : redactValue(x)
    return out
  }
  return v
}

export function redactUrl(raw) {
  try {
    const u = new URL(raw)
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, HIDDEN)
    return u.toString().replaceAll(encodeURIComponent(HIDDEN), HIDDEN)
  } catch {
    return raw
  }
}

function redactBody(text, contentType = '') {
  if (text == null || text === '') return null
  let out = text
  try {
    out = JSON.stringify(redactValue(JSON.parse(text)), null, 2)
  } catch {
    if (/x-www-form-urlencoded/.test(contentType) || /^[\w%.-]+=[^&]*(&[\w%.-]+=[^&]*)*$/.test(text.trim())) {
      const p = new URLSearchParams(text)
      for (const k of [...p.keys()]) if (SECRET_KEY.test(k)) p.set(k, HIDDEN)
      out = p.toString()
    }
  }
  return out.length > BODY_MAX ? `${out.slice(0, BODY_MAX)}\n… (${out.length - BODY_MAX} caracteres a mais, cortados)` : out
}

/** Liga a captura na página. clock0: o instante (ms) que vira 0:00 (início do vídeo). */
export function startCapture(page, clock0, scriptName) {
  const network = []
  const consoleLog = []
  const pending = new Map()
  const work = []
  let bodyBytes = 0
  const t = () => Math.max(0, (Date.now() - clock0) / 1000)

  const onRequest = req => {
    const e = {
      t: t(), roteiro: scriptName, m: req.method(), u: redactUrl(req.url()), type: req.resourceType(),
      s: null, ms: null, size: null, reqHeaders: redactHeaders(req.headers()),
      reqBody: redactBody(req.postData(), req.headers()['content-type']), resHeaders: null, resBody: null, failed: false,
    }
    pending.set(req, e)
    network.push(e)
  }
  const onFinished = req => {
    const e = pending.get(req)
    if (!e) return
    work.push((async () => {
      const res = await req.response().catch(() => null)
      const timing = req.timing()
      if (timing.responseEnd > 0) e.ms = Math.round(timing.responseEnd)
      if (!res) return
      e.s = res.status()
      const headers = await res.allHeaders().catch(() => res.headers())
      e.resHeaders = redactHeaders(headers)
      const len = Number(headers['content-length'])
      if (Number.isFinite(len)) e.size = len
      const ct = headers['content-type'] ?? ''
      // Corpo só de API e de erro: o HTML da página pode trazer token CSRF,
      // estado inicial e dados do usuário embutidos, e mascarar HTML não é confiável.
      const wanted = ['xhr', 'fetch'].includes(e.type) || e.s >= 400
      if (wanted && TEXTUAL.test(ct) && bodyBytes < BODY_TOTAL_MAX) {
        const text = await res.text().catch(() => null)
        if (text != null) {
          if (e.size == null) e.size = Buffer.byteLength(text)
          e.resBody = redactBody(text, ct)
          bodyBytes += e.resBody?.length ?? 0
        }
      }
    })().catch(() => {}))
  }
  const onFailed = req => {
    const e = pending.get(req)
    if (!e) return
    e.failed = true
    e.s = req.failure()?.errorText ?? 'falhou'
  }
  const onConsole = m => consoleLog.push({ t: t(), roteiro: scriptName, type: m.type(), text: String(m.text()).slice(0, 2_000) })
  const onPageError = err => consoleLog.push({ t: t(), roteiro: scriptName, type: 'pageerror', text: String(err.stack || err.message).slice(0, 2_000) })

  page.on('request', onRequest)
  page.on('requestfinished', onFinished)
  page.on('requestfailed', onFailed)
  page.on('console', onConsole)
  page.on('pageerror', onPageError)

  return async () => {
    page.off('request', onRequest)
    page.off('requestfinished', onFinished)
    page.off('requestfailed', onFailed)
    page.off('console', onConsole)
    page.off('pageerror', onPageError)
    // Corpos ainda chegando: espera um pouco, sem travar o fim do roteiro.
    await Promise.race([Promise.allSettled(work), new Promise(r => setTimeout(r, 3_000))])
    return { network, consoleLog }
  }
}
