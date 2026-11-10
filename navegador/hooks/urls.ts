export function normalizeUrl(raw: string): string {
  const text = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^\d+\.\d+\.\d+\.\d+/.test(text)) return `http://${text}`
  return `https://${text}`
}

// Página de trabalho (um editor aberto no painel, não um teste): sem card de
// status, sem legenda na página, e o navegador ocupa o painel inteiro.
// Reconhecida pelo título, que vale em qualquer máquina e porta.
const WORKSPACE_TITLE = /(Visual Studio Code|code-server)$/

export function isWorkspacePage(_url: string | null, title: string): boolean {
  return WORKSPACE_TITLE.test(title.trim())
}
