(() => {
  // Cartão de encerramento sobre a página, no `action done`.
  // DATA = { ok, etapas, acoes, verificacoes, verificacoesOk, tempo, capitulos: [{titulo, ok}] }
  const d = $DATA || {};
  const Z = 2147483647;
  const GREEN = "#22c55e", RED = "#ef4444", PURPLE = "#a855f7";
  const color = d.ok ? GREEN : RED;
  document.getElementById("__ag_end")?.remove();
  // Tudo anima por CSS: o navegador do painel pode segurar setTimeout e
  // requestAnimationFrame da página, e aí número e lista ficavam travados.
  if (!document.getElementById("__ag_end_css")) {
    const css = document.createElement("style");
    css.id = "__ag_end_css";
    css.textContent =
      "@keyframes __ag_in{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:none}}" +
      "@keyframes __ag_fade{from{opacity:0}to{opacity:1}}" +
      "@keyframes __ag_row{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}";
    document.head.appendChild(css);
  }
  const cap = document.getElementById("__ag_caption");
  if (cap) { cap.style.opacity = "0"; cap.style.transform = "translate(-50%, 12px)"; }

  const veil = document.createElement("div");
  veil.id = "__ag_end";
  veil.setAttribute("aria-hidden", "true");
  Object.assign(veil.style, {
    position: "fixed", inset: "0", zIndex: Z, display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(5,5,10,.55)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
    animation: "__ag_fade .4s ease-out both", cursor: "pointer",
  });
  const card = document.createElement("div");
  Object.assign(card.style, {
    width: "min(460px, 88vw)", padding: "26px 28px 22px", borderRadius: "20px",
    background: "linear-gradient(180deg, rgba(24,20,38,.97), rgba(12,10,20,.97))",
    border: "1px solid " + (d.ok ? "rgba(34,197,94,.45)" : "rgba(239,68,68,.5)"),
    boxShadow: "0 30px 80px rgba(0,0,0,.6), 0 0 60px " + (d.ok ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)"),
    font: "500 14px/1.4 ui-sans-serif,-apple-system,system-ui", color: "#f4f4f5",
    animation: "__ag_in .6s cubic-bezier(.2,.8,.2,1) both",
  });

  const el = (tag, style, text) => {
    const n = document.createElement(tag);
    Object.assign(n.style, style || {});
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const head = el("div", { display: "flex", alignItems: "center", gap: "12px", marginBottom: "18px" });
  const badge = el("div", {
    width: "40px", height: "40px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
    background: color, color: "#05050a", font: "800 22px ui-sans-serif,-apple-system,system-ui", flexShrink: "0",
  }, d.ok ? "✓" : "✗");
  const titles = el("div");
  titles.append(
    el("div", { font: "700 19px ui-sans-serif,-apple-system,system-ui" }, d.ok ? "Teste concluído" : "Terminou com falha"),
    el("div", { fontSize: "12px", color: "#a1a1aa", marginTop: "2px" }, "Claude no navegador · " + location.hostname),
  );
  head.append(badge, titles);

  const stats = el("div", { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "16px" });
  const stat = (value, label, accent) => {
    const box = el("div", {
      padding: "10px 8px", borderRadius: "12px", background: "rgba(255,255,255,.04)",
      border: "1px solid rgba(255,255,255,.06)", textAlign: "center",
    });
    const v = el("div", { font: "800 20px ui-sans-serif,-apple-system,system-ui", color: accent || "#fff" }, String(value));
    box.append(v, el("div", { fontSize: "11px", color: "#a1a1aa", marginTop: "2px" }, label));
    return { box, v, value };
  };
  const items = [
    stat(d.etapas ?? 0, "etapas"),
    stat(d.acoes ?? 0, "ações"),
    stat(`${d.verificacoesOk ?? 0}/${d.verificacoes ?? 0}`, "verificações", d.verificacoes ? color : undefined),
    stat(d.tempo ?? "", "tempo ativo"),
  ];
  items.forEach(i => stats.append(i.box));

  const list = el("div", { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "14px" });
  // O plugin já manda as falhas primeiro e no máximo 5 etapas.
  (d.capitulos || []).slice(0, 5).forEach((c, i) => {
    const row = el("div", {
      display: "flex", gap: "8px", alignItems: "baseline", fontSize: "13px", color: "#d4d4d8",
      animation: "__ag_row .35s ease-out both", animationDelay: (0.45 + i * 0.12) + "s",
    });
    const text = el("span", {}, c.titulo);
    if (c.falhou) text.append(el("span", { color: RED, marginLeft: "6px", fontSize: "12px" }, "· falhou: " + c.falhou));
    row.append(el("span", { color: c.ok ? GREEN : RED, fontWeight: "700" }, c.ok ? "✓" : "✗"), text);
    list.append(row);
  });

  const foot = el("div", { fontSize: "11px", color: "#71717a", textAlign: "center" }, "clique para fechar");
  card.append(head, stats, list, foot);
  veil.append(card);
  veil.addEventListener("click", () => veil.remove());
  (document.body || document.documentElement).appendChild(veil);

  // Some sozinha quando a próxima ação do agente começar (feedback.js e
  // caption.js removem #__ag_end), ou com um clique.
})()
