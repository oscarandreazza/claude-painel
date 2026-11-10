(() => {
  // Desenhado pelo tb-agent-browser antes de cada ação do agente.
  //
  // Contorno e selo seguem o ELEMENTO, não a posição do clique: um laço de
  // requestAnimationFrame relê getBoundingClientRect a cada quadro. Assim nada
  // fica pra trás em site com rolagem suave por JS (Lenis e afins), onde
  // posição absoluta na página não acompanha a rolagem.
  const b = $B, verb = $V, ripple = $R === 1;
  // b.p = true: prévia durante a rolagem, só o cursor vai na direção do alvo.
  const preview = b.p === true;
  const Z = 2147483647, PURPLE = "#a855f7", DEEP = "#7c3aed";
  const root = document.documentElement;
  // Texto do agente num shadow root fechado: o getByText do Playwright (tb-run)
  // não atravessa, então cursor, rótulo e selo nunca "passam" uma verificação.
  const say = (host, text) => {
    const sr = host.__agText || (host.__agText = host.attachShadow({ mode: "closed" }));
    sr.textContent = text;
  };
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  // Nova ação: tira a tela final da rodada anterior, se ficou.
  document.getElementById("__ag_end")?.remove();
  // Saídas por CSS, que rodam mesmo se o navegador segurar os timers da página.
  if (!document.getElementById("__ag_fb_css")) {
    const css = document.createElement("style");
    css.id = "__ag_fb_css";
    css.textContent =
      "@keyframes __ag_out{to{opacity:0;visibility:hidden}}" +
      ".__ag_box{animation:__ag_out .3s ease-in 1.5s forwards}" +
      "#__ag_cursor.__ag_idle{animation:__ag_out .4s ease-in 2.5s forwards}";
    (document.head || root).appendChild(css);
  }

  // O elemento no centro do retângulo, subindo até o controle clicável mais
  // próximo (o texto dentro do botão e o botão viram o mesmo alvo); ignora o
  // que o próprio agente desenhou.
  const CONTROL = "a, button, input, select, textarea, label, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [tabindex]";
  // Entre tudo que está empilhado no ponto, fica o elemento cujo retângulo
  // bate com o do alvo (o navegador mede o elemento certo): ignora popup
  // flutuante por cima e não confunde com o botão vizinho.
  const target = (() => {
    let best = null, bestScore = Infinity;
    for (const el of document.elementsFromPoint(cx, cy)) {
      if (el.closest("#__ag_cursor, .__ag_box, .__ag_badge, #__ag_caption, #__ag_end")) continue;
      const r = el.getBoundingClientRect();
      const score = Math.abs(r.left - b.x) + Math.abs(r.top - b.y) + Math.abs(r.width - b.w) + Math.abs(r.height - b.h);
      if (score < bestScore) { best = el; bestScore = score; }
    }
    if (!best) return null;
    // Texto dentro de um botão vira o botão, se o botão tem quase o mesmo tamanho.
    const ctl = best.closest(CONTROL);
    return ctl || best;
  })();

  // Laço único que reposiciona tudo que está preso a um elemento.
  const S = (window.__ag = window.__ag || { tracked: new Set(), badges: new Map(), n: 0, loop: false });
  const place = (item) => {
    const el = item.el;
    if (!el || !el.isConnected) { item.node.remove(); S.tracked.delete(item); if (item.badge) S.badges.delete(el); return; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { item.node.style.visibility = "hidden"; return; }
    item.node.style.visibility = "visible";
    const ox = item.center ? r.width / 2 : 0, oy = item.center ? r.height / 2 : 0;
    item.node.style.left = (r.left + ox + item.dx) + "px";
    item.node.style.top = (r.top + oy + item.dy) + "px";
    if (item.fit) { item.node.style.width = (r.width + 10) + "px"; item.node.style.height = (r.height + 10) + "px"; }
  };
  if (!S.loop) {
    S.loop = true;
    const tick = () => { S.tracked.forEach(place); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  const track = (node, opts) => {
    const item = { node, el: target, dx: 0, dy: 0, fit: false, badge: false, center: false, ...opts };
    if (target) { S.tracked.add(item); place(item); }
    return item;
  };

  // Cursor do agente: seta roxa com a etiqueta "Claude", estilo cursor multiplayer.
  let c = document.getElementById("__ag_cursor");
  if (!c) {
    c = document.createElement("div");
    c.id = "__ag_cursor";
    c.setAttribute("aria-hidden", "true");
    Object.assign(c.style, {
      position: "fixed", zIndex: Z, pointerEvents: "none", left: "24px", top: "24px",
      transition: "left .45s cubic-bezier(.2,.8,.2,1), top .45s cubic-bezier(.2,.8,.2,1), opacity .4s",
      filter: "drop-shadow(0 2px 6px rgba(0,0,0,.45))",
    });
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.7L21 10.6z" fill="' + PURPLE + '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<div style="position:absolute;left:18px;top:16px;font:600 11px ui-sans-serif,-apple-system,system-ui;color:#fff;background:' + DEEP + ';padding:2px 7px;border-radius:9px;white-space:nowrap"></div>';
    say(c.lastElementChild, "Claude");
    root.appendChild(c);
  }
  c.style.opacity = "1";
  // Reinicia a contagem pra sumir parado.
  c.classList.remove("__ag_idle");
  void c.offsetWidth;
  c.classList.add("__ag_idle");
  // O cursor persegue o centro do alvo (a transição suaviza), inclusive
  // enquanto a página ainda rola até ele.
  if (S.cursorItem) S.tracked.delete(S.cursorItem);
  S.cursorItem = null;
  if (target) {
    requestAnimationFrame(() => { S.cursorItem = track(c, { center: true, dx: -3, dy: -2 }); });
  } else {
    requestAnimationFrame(() => { c.style.left = (cx - 3) + "px"; c.style.top = (cy - 2) + "px"; });
  }
  // O cursor some depois de um tempo parado, pra não ficar solto na página.
  clearTimeout(S.cursorTimer);
  S.cursorTimer = setTimeout(() => {
    c.style.opacity = "0";
    if (S.cursorItem) { S.tracked.delete(S.cursorItem); S.cursorItem = null; }
  }, 2500);

  if (preview) return;

  // Contorno do alvo com o nome da ação, preso ao elemento.
  const r = document.createElement("div");
  r.className = "__ag_box";
  r.setAttribute("aria-hidden", "true");
  Object.assign(r.style, {
    position: "fixed", zIndex: Z - 2, pointerEvents: "none",
    left: (b.x - 5) + "px", top: (b.y - 5) + "px", width: (b.w + 10) + "px", height: (b.h + 10) + "px",
    border: "2px solid " + PURPLE, borderRadius: "8px", background: "rgba(168,85,247,.10)",
    // Holofote: a sombra gigante escurece a página toda, menos o alvo.
    boxShadow: "0 0 0 4px rgba(168,85,247,.18), 0 0 0 200vmax rgba(5,5,10,.42)",
    opacity: "0", transform: "scale(1.08)",
    transition: "opacity .3s, transform .25s cubic-bezier(.2,.8,.2,1)",
  });
  const l = document.createElement("div");
  say(l, verb);
  Object.assign(l.style, {
    position: "absolute", top: "-24px", left: "-2px", font: "600 11px ui-sans-serif,-apple-system,system-ui",
    color: "#fff", background: DEEP, padding: "3px 8px", borderRadius: "6px", whiteSpace: "nowrap",
  });
  r.appendChild(l);
  root.appendChild(r);
  const box = track(r, { dx: -5, dy: -5, fit: true });
  requestAnimationFrame(() => { r.style.opacity = "1"; r.style.transform = "scale(1)"; });

  // Rastro: um selo por elemento, com o número da última vez que o agente
  // mexeu nele; fica até a navegação ou até o elemento sair da página.
  S.n += 1;
  let badge = target ? S.badges.get(target) : null;
  if (badge) {
    say(badge, String(S.n));
    badge.animate([{ transform: "scale(1.5)" }, { transform: "scale(1)" }], { duration: 300, easing: "cubic-bezier(.34,1.56,.64,1)" });
  } else {
    badge = document.createElement("div");
    badge.className = "__ag_badge";
    badge.setAttribute("aria-hidden", "true");
    say(badge, String(S.n));
    Object.assign(badge.style, {
      position: "fixed", zIndex: Z - 3, pointerEvents: "none",
      left: (b.x - 9) + "px", top: (b.y - 9) + "px",
      minWidth: "18px", height: "18px", padding: "0 5px", boxSizing: "border-box",
      borderRadius: "9px", background: DEEP, color: "#fff", border: "1.5px solid #fff",
      font: "700 10px/15px ui-sans-serif,-apple-system,system-ui", textAlign: "center",
      boxShadow: "0 2px 6px rgba(0,0,0,.35)", opacity: "0", transform: "scale(.4)",
      transition: "opacity .25s, transform .3s cubic-bezier(.34,1.56,.64,1)",
    });
    root.appendChild(badge);
    if (target) { S.badges.set(target, badge); track(badge, { dx: -9, dy: -9, badge: true }); }
    requestAnimationFrame(() => { badge.style.opacity = "1"; badge.style.transform = "scale(1)"; });
  }

  // Onda no ponto do clique, quando o cursor chega.
  if (ripple) {
    setTimeout(() => {
      // Onde o alvo está agora, não onde estava quando o desenho começou.
      const now = target && target.isConnected ? target.getBoundingClientRect() : null;
      const wx = now ? now.left + now.width / 2 : cx, wy = now ? now.top + now.height / 2 : cy;
      const w = document.createElement("div");
      Object.assign(w.style, {
        position: "fixed", zIndex: Z - 1, pointerEvents: "none", left: (wx - 6) + "px", top: (wy - 6) + "px",
        width: "12px", height: "12px", borderRadius: "50%", border: "2px solid " + PURPLE,
        background: "rgba(168,85,247,.25)", transform: "scale(1)", opacity: "1",
        transition: "transform .55s ease-out, opacity .55s ease-out",
      });
      root.appendChild(w);
      requestAnimationFrame(() => { w.style.transform = "scale(4.5)"; w.style.opacity = "0"; });
      setTimeout(() => w.remove(), 600);
    }, 420);
  }

  setTimeout(() => {
    r.style.opacity = "0";
    setTimeout(() => { r.remove(); S.tracked.delete(box); }, 300);
  }, 1400);
})()
