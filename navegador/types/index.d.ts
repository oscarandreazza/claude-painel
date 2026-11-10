// Estado da sessão do plugin navegador: sobrevive a /reload-plugins, ao
// contrário das variáveis do módulo. Guarda a ponte com o terminal-browser pra
// um reload reaproveitar o navegador aberto em vez de deixar um órfão.
// `chromeless`: o navegador dela nasceu sem a barra de endereço (modo de trabalho).
export type Bridge = { port: number; token: string; chromeless?: boolean }

declare module 'claude-code' {
  interface PluginState {
    navegador: { bridge: Bridge | null }
  }
}
