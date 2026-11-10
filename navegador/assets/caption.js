(() => {
  // Legenda no rodapé da página: o que o agente está fazendo agora.
  // DATA = { title, sub? } pra mostrar, ou { hide: true } pra recolher.
  const d = $DATA || {};
  const Z = 2147483647, DEEP = "#7c3aed", PURPLE = "#a855f7";
  // Etapa nova: tira a tela final da rodada anterior, se ficou.
  if (!d.hide) document.getElementById("__ag_end")?.remove();
  let cap = document.getElementById("__ag_caption");
  // O texto mora num shadow root fechado: o getByText do Playwright (tb-run)
  // não atravessa, então a legenda nunca "passa" uma verificação da página.
  let root = window.__agCapRoot;
  if (cap && !root) { cap.remove(); cap = null; }
  if (d.hide) {
    if (cap) { cap.style.opacity = "0"; cap.style.transform = "translate(-50%, 12px)"; }
    return;
  }
  if (!cap) {
    cap = document.createElement("div");
    cap.id = "__ag_caption";
    cap.setAttribute("aria-hidden", "true");
    Object.assign(cap.style, {
      position: "fixed", left: "50%", bottom: "22px", zIndex: Z, pointerEvents: "none",
      transform: "translate(-50%, 12px)", opacity: "0", maxWidth: "min(720px, 86vw)",
      display: "flex", alignItems: "center", gap: "12px", padding: "10px 18px 10px 14px",
      background: "rgba(12,10,20,.86)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
      border: "1px solid rgba(168,85,247,.45)", borderRadius: "14px",
      boxShadow: "0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.04) inset",
      font: "500 14px/1.35 ui-sans-serif,-apple-system,system-ui", color: "#f4f4f5",
      transition: "opacity .35s, transform .45s cubic-bezier(.2,.8,.2,1)",
    });
    const dot = document.createElement("div");
    Object.assign(dot.style, {
      width: "10px", height: "10px", borderRadius: "50%", background: PURPLE, flexShrink: "0",
      boxShadow: "0 0 0 0 rgba(168,85,247,.6)",
    });
    dot.animate(
      [{ boxShadow: "0 0 0 0 rgba(168,85,247,.6)" }, { boxShadow: "0 0 0 10px rgba(168,85,247,0)" }],
      { duration: 1400, iterations: Infinity },
    );
    const text = document.createElement("div");
    text.innerHTML = '<div class="__ag_cap_title" style="font-weight:600"></div>' +
      '<div class="__ag_cap_sub" style="font-size:12px;color:#c4b5fd;margin-top:2px"></div>';
    const who = document.createElement("div");
    who.textContent = "Claude";
    Object.assign(who.style, {
      font: "700 11px ui-sans-serif,-apple-system,system-ui", color: "#fff", background: DEEP,
      padding: "3px 8px", borderRadius: "8px", flexShrink: "0",
    });
    root = cap.attachShadow({ mode: "closed" });
    window.__agCapRoot = root;
    root.append(dot, who, text);
    (document.body || document.documentElement).appendChild(cap);
  }
  const title = root.querySelector(".__ag_cap_title");
  const sub = root.querySelector(".__ag_cap_sub");
  if (d.title && title.textContent !== d.title) {
    title.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 300 });
    title.textContent = d.title;
  }
  if (typeof d.sub === "string") sub.textContent = d.sub;
  sub.style.display = sub.textContent ? "block" : "none";
  requestAnimationFrame(() => { cap.style.opacity = "1"; cap.style.transform = "translate(-50%, 0)"; });
})()
