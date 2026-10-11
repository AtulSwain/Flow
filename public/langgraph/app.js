/* LangGraph Atlas — interactions, 3D hero, runtime simulator */
(() => {
  "use strict";
  const D = window.ATLAS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- Syntax highlighting (tiny, single pass) ---------------- */
  const KW = "from|import|def|class|return|if|else|elif|for|in|while|with|as|async|await|lambda|yield|not|and|or|is|None|True|False|const|let|var|new|function|export|typeof|of|try|except|raise";
  const TOKEN = new RegExp(
    [
      "(#[^\\n]*|\\/\\/[^\\n]*)", // 1 comment
      '("""[\\s\\S]*?"""|f?"(?:\\\\.|[^"\\\\\\n])*"|f?\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)', // 2 string
      "(@\\w+)", // 3 decorator
      "\\b(" + KW + ")\\b", // 4 keyword
      "\\b(\\d+(?:\\.\\d+)?)\\b", // 5 number
      "\\b([A-Za-z_]\\w*)(?=\\()", // 6 call
    ].join("|"),
    "g"
  );
  function highlight(src) {
    let out = "", last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(src))) {
      out += esc(src.slice(last, m.index));
      const [t] = m;
      const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "d" : m[4] ? "k" : m[5] ? "n" : "f";
      out += `<span class="${cls}">${esc(t)}</span>`;
      last = m.index + t.length;
    }
    return out + esc(src.slice(last));
  }

  /* ---------------- SVG graph renderer ---------------- */
  let svgUid = 0;
  function nodeBox(n, o) {
    const w = Math.max(o.minW, n.label.length * o.charW + o.padX);
    return { x: n.x, y: n.y, hw: w / 2, hh: o.nodeH / 2 };
  }
  function clip(b, tx, ty, pad) {
    const dx = tx - b.x, dy = ty - b.y;
    const t = Math.min(dx ? b.hw / Math.abs(dx) : Infinity, dy ? b.hh / Math.abs(dy) : Infinity);
    const len = Math.hypot(dx, dy) || 1;
    return [b.x + dx * t + (dx / len) * pad, b.y + dy * t + (dy / len) * pad];
  }
  function renderGraph(spec, opt = {}) {
    const o = Object.assign({ w: 300, h: 180, nodeH: 22, charW: 6.6, padX: 16, minW: 44, radius: 7, flow: true, labels: {} }, opt);
    const id = "g" + ++svgUid;
    const byId = Object.fromEntries(spec.nodes.map((n) => [n.id, nodeBox(n, o)]));
    let edges = "", flows = "";
    spec.edges.forEach(([a, b, e = {}]) => {
      const A = byId[a], B = byId[b];
      let d;
      if (e.loop) {
        const x = A.x, y = A.y - A.hh;
        d = `M${x - 10},${y} C${x - 26},${y - 34} ${x + 26},${y - 34} ${x + 10},${y - 2}`;
      } else if (e.bend) {
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
        const cx = mx + (-dy / len) * e.bend * 2, cy = my + (dx / len) * e.bend * 2;
        const [x1, y1] = clip(A, cx, cy, 1), [x2, y2] = clip(B, cx, cy, 4);
        d = `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
      } else {
        const [x1, y1] = clip(A, B.x, B.y, 1), [x2, y2] = clip(B, A.x, A.y, 4);
        d = `M${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}`;
      }
      edges += `<path class="g-edge${e.dashed ? " dashed" : ""}" d="${d}" data-from="${a}" data-to="${b}" marker-end="url(#${id}-arr)"/>`;
      if (o.flow) flows += `<path class="flow" d="${d}" style="animation-delay:${(-Math.random() * 1.6).toFixed(2)}s"/>`;
      const lbl = o.labels[a + ">" + b];
      if (lbl) edges += `<text class="g-label" x="${lbl[1]}" y="${lbl[2]}">${esc(lbl[0])}</text>`;
    });
    const nodes = spec.nodes.map((n) => {
      const b = byId[n.id];
      return `<g class="g-node ${n.kind || ""}" data-id="${n.id}"><rect x="${(b.x - b.hw).toFixed(1)}" y="${(b.y - b.hh).toFixed(1)}" width="${(b.hw * 2).toFixed(1)}" height="${(b.hh * 2).toFixed(1)}" rx="${n.kind === "terminal" ? b.hh : o.radius}"/><text x="${b.x}" y="${b.y}">${esc(n.label)}</text></g>`;
    }).join("");
    return `<svg viewBox="0 0 ${o.w} ${o.h}" xmlns="http://www.w3.org/2000/svg" ${o.attrs || 'aria-hidden="true"'}>
      <defs>
        <marker id="${id}-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="${o.arrow || 6}" markerHeight="${o.arrow || 6}" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="rgba(255,255,255,.55)"/></marker>
        ${o.glow ? '<filter id="runner-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' : ""}
      </defs>
      <g>${edges}</g><g>${flows}</g><g>${nodes}</g>
    </svg>`;
  }

  /* ---------------- Nav ---------------- */
  const nav = $("#nav"), burger = $("#burger"), links = $("#navLinks");
  burger.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    burger.setAttribute("aria-expanded", open);
  });
  links.addEventListener("click", (e) => {
    if (e.target.tagName === "A") { links.classList.remove("open"); burger.setAttribute("aria-expanded", "false"); }
  });
  const progress = $(".scroll-progress span");
  const onScroll = () => {
    const h = document.documentElement;
    nav.classList.toggle("scrolled", h.scrollTop > 40);
    progress.style.width = (h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100 + "%";
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const navMap = new Map($$("a", links).map((a) => [a.getAttribute("href").slice(1), a]));
  const secObs = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting && navMap.has(en.target.id)) {
        navMap.forEach((a) => a.classList.remove("active"));
        navMap.get(en.target.id).classList.add("active");
      }
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  $$("section[id]").forEach((s) => secObs.observe(s));

  /* ---------------- Content rendering ---------------- */
  // Hero counters reflect the actual data
  const counts = [D.architectures.length, D.patterns.length, D.models.length, D.papers.length];
  $$(".hero-stats dt").forEach((dt, i) => (dt.dataset.count = counts[i]));

  // Concepts
  $("#conceptGrid").innerHTML = D.concepts.map((c, i) => `
    <div class="flip reveal" role="button" tabindex="0" aria-pressed="false" aria-label="${esc(c.name)} — flip for code" style="--h:${Math.round((i * 360) / D.concepts.length + 190) % 360}">
      <div class="flip-inner">
        <div class="flip-face flip-front">
          <div class="c-icon" aria-hidden="true">${c.icon}</div>
          <span class="c-tag">${esc(c.tag)}</span>
          <h3>${esc(c.name)}</h3>
          <p>${esc(c.text)}</p>
          <span class="flip-hint">↻ tap for code</span>
        </div>
        <div class="flip-face flip-back">
          <span class="c-tag">${esc(c.name)}</span>
          <pre><code>${highlight(c.code)}</code></pre>
        </div>
      </div>
    </div>`).join("");

  function flipper(root) {
    const toggle = (card) => {
      const on = card.classList.toggle("flipped");
      card.setAttribute("aria-pressed", on);
    };
    root.addEventListener("click", (e) => { const c = e.target.closest(".flip"); if (c) toggle(c); });
    root.addEventListener("keydown", (e) => {
      const c = e.target.closest(".flip");
      if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(c); }
    });
  }
  flipper($("#conceptGrid"));

  // Architectures
  const famName = { single: "Single agent", multi: "Multi-agent", planning: "Planning & reasoning", rag: "Retrieval" };
  $("#archGrid").innerHTML = D.architectures.map((a) => `
    <article class="arch-card tilt reveal" data-fam="${a.family}" data-id="${a.id}" tabindex="0" role="button" aria-label="Open ${esc(a.name)} details" style="--h:${a.hue}">
      <div class="arch-dia dia">${renderGraph(a.diagram)}</div>
      <div class="arch-body">
        <span class="arch-fam">${famName[a.family]}</span>
        <h3>${esc(a.name)}</h3>
        <p>${esc(a.tagline)} ${esc(a.desc.split(". ")[0])}.</p>
        <div class="tags">${a.primitives.map((p) => `<span>${esc(p)}</span>`).join("")}</div>
        <span class="arch-open">Deep-dive →</span>
      </div>
    </article>`).join("");

  $("#archFilters").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    $$(".chip", e.currentTarget).forEach((c) => c.classList.toggle("active", c === btn));
    const f = btn.dataset.filter;
    $$(".arch-card").forEach((card) => {
      const show = f === "all" || card.dataset.fam === f;
      card.classList.toggle("hide", !show);
      if (show) { card.classList.add("in"); }
    });
  });

  // Modal
  const modal = $("#modal"), modalBody = $("#modalBody");
  let lastFocus = null;
  function openArch(id) {
    const a = D.architectures.find((x) => x.id === id);
    if (!a) return;
    lastFocus = document.activeElement;
    modal.querySelector(".modal-card").style.setProperty("--h", a.hue);
    modalBody.innerHTML = `
      <span class="kicker" style="color:hsl(${a.hue},85%,70%)">${famName[a.family]}</span>
      <h2 id="modalTitle" style="font-size:clamp(1.6rem,4vw,2.3rem)">${esc(a.name)}</h2>
      <p style="font-size:1.05rem;color:#fff">${esc(a.tagline)}</p>
      <div class="modal-dia dia" style="--h:${a.hue}">${renderGraph(a.diagram, { attrs: 'role="img" aria-label="' + esc(a.name) + ' graph diagram"' })}</div>
      <p>${esc(a.desc)}</p>
      <div class="modal-cols">
        <div><h4>Use it when</h4><ul class="ticks">${a.when.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>
        <div><h4>Trade-offs</h4><p>${esc(a.tradeoffs)}</p>
          <h4>Key primitives</h4><div class="tags">${a.primitives.map((p) => `<span>${esc(p)}</span>`).join("")}</div>
          ${a.paper !== "—" ? `<h4 style="margin-top:16px">Research</h4><p>${esc(a.paper)}</p>` : ""}
        </div>
      </div>`;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    $(".modal-x", modal).focus();
  }
  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = "";
    if (lastFocus) lastFocus.focus();
  }
  $("#archGrid").addEventListener("click", (e) => { const c = e.target.closest(".arch-card"); if (c) openArch(c.dataset.id); });
  $("#archGrid").addEventListener("keydown", (e) => {
    const c = e.target.closest(".arch-card");
    if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openArch(c.dataset.id); }
  });
  modal.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") closeModal();
    if (e.key === "Tab") { // keep focus inside the dialog
      const f = $$("button, a[href], [tabindex]:not([tabindex='-1'])", modal);
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Patterns
  const pList = $("#patternList"), pView = $("#patternView");
  pList.innerHTML = D.patterns.map((p, i) => `
    <button class="pattern-tab${i ? "" : " active"}" role="tab" aria-selected="${!i}" data-i="${i}">
      <span class="num">0${i + 1}</span><b>${esc(p.name)}</b><span class="pill ${p.kind}">${p.kind}</span>
    </button>`).join("");
  function showPattern(i) {
    const p = D.patterns[i];
    $$(".pattern-tab", pList).forEach((t, j) => { t.classList.toggle("active", i === j); t.setAttribute("aria-selected", i === j); });
    pView.style.animation = "none"; void pView.offsetWidth; pView.style.animation = "";
    pView.innerHTML = `
      <h3 style="font-size:1.5rem">${esc(p.name)}</h3>
      <p>${esc(p.desc)}</p>
      <div class="pv-dia dia" style="--h:${190 + i * 25}">${renderGraph(p.diagram)}</div>
      <dl class="pv-meta"><dt>Type</dt><dd>${p.kind === "agent" ? "Agent — model-driven control flow" : "Workflow — code-driven control flow"}</dd>
      <dt>Primitive</dt><dd><code>${esc(p.primitive)}</code></dd><dt>Use when</dt><dd>${esc(p.when)}</dd></dl>
      <pre class="inline-code"><code>${highlight(p.code)}</code></pre>`;
  }
  pList.addEventListener("click", (e) => { const t = e.target.closest(".pattern-tab"); if (t) showPattern(+t.dataset.i); });
  showPattern(0);

  // Models
  $("#modelGrid").innerHTML = D.models.map((m) => `
    <div class="model flip reveal${m.gray ? " gray" : ""}" role="button" tabindex="0" aria-pressed="false" aria-label="${esc(m.name)} — flip for details" style="--h:${m.hue}">
      <div class="flip-inner">
        <div class="flip-face flip-front">
          <div class="m-logo" aria-hidden="true">${esc(m.name.replace(/[^A-Za-z ]/g, "").split(" ").map((w) => w[0]).slice(0, 2).join(""))}</div>
          <h3>${esc(m.name)}</h3>
          <span class="m-pkg">${esc(m.pkg)}</span>
          <span class="flip-hint">↻ tap for details</span>
        </div>
        <div class="flip-face flip-back">
          <p>${esc(m.note)}</p>
          <code>${esc(m.prefix)}</code>
        </div>
      </div>
    </div>`).join("");
  flipper($("#modelGrid"));

  $("#capList").innerHTML = D.capabilities.map((c) => `
    <div class="cap"><b>${esc(c.name)}</b>
      <span class="bars" aria-label="Importance ${c.level} of 5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= c.level ? "on" : ""}"></i>`).join("")}</span>
      <p>${esc(c.text)}</p></div>`).join("");

  // Timeline & papers
  $("#timeline").innerHTML = D.timeline.map((t) => `<li><time>${esc(t.when)}</time><h4>${esc(t.title)}</h4><p>${esc(t.text)}</p></li>`).join("");
  $("#paperGrid").innerHTML = D.papers.map((p) => `
    <a class="paper reveal" href="${p.link}" target="_blank" rel="noopener">
      <span class="yr" aria-hidden="true">${p.year}</span>
      <span class="arch">${esc(p.arch)}</span>
      <h4>${esc(p.title)}</h4>
      <p>${esc(p.idea)}</p>
      <span class="who">${esc(p.who)} · ${p.year} ↗</span>
    </a>`).join("");

  // FAQ
  $("#faqList").innerHTML = D.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("");

  // Checklist with local persistence
  const CK = "lg-atlas-checklist";
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(CK) || "[]"); } catch (_) { saved = []; }
  $("#checklist").innerHTML = D.checklist.map(([t, d], i) => `
    <li><input type="checkbox" id="ck${i}" ${saved.includes(i) ? "checked" : ""}/>
      <label for="ck${i}"><span class="box" aria-hidden="true"></span><span><b>${esc(t)}</b><span class="t">${esc(d)}</span></span></label></li>`).join("");
  const ring = $("#ringFg"), ringPct = $("#ringPct"), CIRC = 2 * Math.PI * 52;
  function updateRing() {
    const boxes = $$("#checklist input");
    const on = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0);
    const pct = Math.round((on.length / boxes.length) * 100);
    ring.style.strokeDashoffset = CIRC * (1 - pct / 100);
    ring.style.stroke = pct === 100 ? "var(--lime)" : pct >= 50 ? "var(--violet)" : "var(--cyan)";
    ringPct.textContent = pct + "%";
    try { localStorage.setItem(CK, JSON.stringify(on)); } catch (_) { /* storage unavailable */ }
  }
  ring.style.strokeDasharray = CIRC;
  $("#checklist").addEventListener("change", updateRing);
  updateRing();

  // Code tabs
  const codeBody = $("#codeBody");
  let currentCode = "py";
  const showCode = (k) => {
    currentCode = k;
    codeBody.innerHTML = highlight(D.code[k]);
    $$(".code-tabs [data-code]").forEach((b) => { b.classList.toggle("active", b.dataset.code === k); b.setAttribute("aria-selected", b.dataset.code === k); });
  };
  $(".code-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-code]"); if (b) showCode(b.dataset.code); });
  showCode("py");
  $("#copyBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(D.code[currentCode]);
      btn.textContent = "Copied ✓";
    } catch (_) {
      const r = document.createRange(); r.selectNodeContents(codeBody);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      btn.textContent = "Selected — ⌘/Ctrl+C";
    }
    btn.classList.add("ok");
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("ok"); }, 1800);
  });

  /* ---------------- Reveal + counters ---------------- */
  const countUp = (el) => {
    const end = +el.dataset.count, t0 = performance.now(), dur = reduceMotion ? 1 : 1400;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const revObs = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add("in");
      $$("[data-count]", en.target).forEach(countUp);
      revObs.unobserve(en.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  // Stagger siblings in grids
  $$(".reveal").forEach((el) => {
    const sibs = el.parentElement ? $$(":scope > .reveal", el.parentElement) : [];
    const i = sibs.indexOf(el);
    if (sibs.length > 2 && i > 0) el.style.transitionDelay = Math.min(i, 8) * 60 + "ms";
    revObs.observe(el);
  });

  /* ---------------- 3D tilt ---------------- */
  if (finePointer && !reduceMotion) {
    document.addEventListener("pointermove", (e) => {
      const card = e.target.closest(".tilt");
      if (!card) return;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      card.style.transform = `perspective(900px) rotateY(${(px - 0.5) * 12}deg) rotateX(${(0.5 - py) * 10}deg) translateZ(6px)`;
      card.style.setProperty("--mx", px * 100 + "%");
      card.style.setProperty("--my", py * 100 + "%");
    });
    document.addEventListener("pointerout", (e) => {
      const card = e.target.closest(".tilt");
      if (card && !card.contains(e.relatedTarget)) card.style.transform = "";
    });
  }

  /* ---------------- Ecosystem 3D stack ---------------- */
  (() => {
    const stack = $("#stack"), wrap = $(".stack-wrap");
    const layers = $$(".layer", stack);
    layers.forEach((l, i) => l.style.setProperty("--i", layers.length - 1 - i));
    let rx = 52, rz = -36, spread = 0, target = 95, hover = -1;
    const legend = $$(".legend-item", wrap);
    legend.forEach((it, i) => {
      it.addEventListener("pointerenter", () => (hover = i));
      it.addEventListener("pointerleave", () => (hover = -1));
    });
    let tx = rx, tz = rz;
    if (finePointer) wrap.addEventListener("pointermove", (e) => {
      const r = stack.getBoundingClientRect();
      tz = -36 + ((e.clientX - r.left) / r.width - 0.5) * 30;
      tx = 52 + ((e.clientY - r.top) / r.height - 0.5) * -16;
    });
    const io = new IntersectionObserver(([en]) => (target = en.isIntersecting ? 95 : 0), { threshold: 0.3 });
    io.observe(stack);
    const apply = () => {
      stack.style.transform = `rotateX(${rx}deg) rotateZ(${rz}deg)`;
      layers.forEach((l, i) => {
        const lift = hover === i ? 28 : 0;
        l.style.transform = `translateZ(${(layers.length - 1 - i) * spread + lift - 1.5 * spread}px)`;
        l.style.opacity = hover === -1 || hover === i ? 1 : 0.45;
      });
    };
    if (reduceMotion) { spread = 95; apply(); return; }
    const loop = () => {
      rx += (tx - rx) * 0.08; rz += (tz - rz) * 0.08; spread += (target - spread) * 0.06;
      apply();
      requestAnimationFrame(loop);
    };
    loop();
  })();

  /* ---------------- Hero: dependency-free 3D graph engine ---------------- */
  (() => {
    const cvs = $("#heroCanvas");
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const PALETTE = ["#22d3ee", "#8b5cf6", "#f472b6", "#a3e635", "#60a5fa"];
    let W = 0, H = 0, DPR = 1, running = true, mouseX = 0, mouseY = 0, mx = 0, my = 0;

    const small = window.innerWidth < 700;
    const N = small ? 34 : 56;
    const R = 260;
    // Nodes: points spread on a few shells -> reads as a layered graph
    const nodes = [];
    for (let i = 0; i < N; i++) {
      const shell = i % 3;
      const r = R * (0.55 + shell * 0.22) * (0.85 + Math.random() * 0.3);
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      nodes.push({ x: r * s * Math.cos(th), y: r * u * 0.8, z: r * s * Math.sin(th), c: PALETTE[i % PALETTE.length], size: i < 5 ? 7 : 3 + Math.random() * 2.5, adj: [] });
    }
    // Edges: k nearest neighbours
    const edges = [];
    const seen = new Set();
    nodes.forEach((a, i) => {
      const near = nodes.map((b, j) => [j, (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2]).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]).slice(0, i < 5 ? 5 : 2);
      near.forEach(([j]) => {
        const key = i < j ? i + "-" + j : j + "-" + i;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push([i, j]);
        a.adj.push(j); nodes[j].adj.push(i);
      });
    });
    // Background stars
    const stars = Array.from({ length: small ? 120 : 260 }, () => {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u), r = 900 + Math.random() * 600;
      return { x: r * s * Math.cos(th), y: r * u, z: r * s * Math.sin(th), a: 0.2 + Math.random() * 0.6 };
    });
    // Packets traverse the graph like messages between nodes
    const packets = Array.from({ length: small ? 10 : 18 }, () => {
      const from = Math.floor(Math.random() * N);
      return { from, to: nodes[from].adj[0] ?? 0, t: Math.random(), v: 0.004 + Math.random() * 0.008, trail: [] };
    });

    // Pre-rendered glow sprites per colour
    const sprites = {};
    PALETTE.concat("#ffffff").forEach((c) => {
      const s = document.createElement("canvas"); s.width = s.height = 64;
      const g = s.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, "#fff"); grd.addColorStop(0.18, c); grd.addColorStop(0.45, c + "55"); grd.addColorStop(1, c + "00");
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
      sprites[c] = s;
    });

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = cvs.clientWidth; H = cvs.clientHeight;
      cvs.width = W * DPR; cvs.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", (e) => { mouseX = e.clientX / window.innerWidth - 0.5; mouseY = e.clientY / window.innerHeight - 0.5; }, { passive: true });

    const proj = { x: 0, y: 0, z: 0, s: 0 };
    function project(p, cy, sy, cx, sx, out) {
      // rotate Y then X, then perspective
      const x1 = p.x * cy - p.z * sy, z1 = p.x * sy + p.z * cy;
      const y2 = p.y * cx - z1 * sx, z2 = p.y * sx + z1 * cx;
      const zc = z2 + 820, f = Math.min(W, H) * 1.05 / zc;
      out.x = W / 2 + x1 * f; out.y = H * 0.5 + y2 * f; out.z = z2; out.s = f;
      return out;
    }
    const P = nodes.map(() => ({ x: 0, y: 0, z: 0, s: 0 }));

    function frame(time) {
      if (!running) return;
      const t = time * 0.001;
      mx += (mouseX - mx) * 0.04; my += (mouseY - my) * 0.04;
      const ay = (reduceMotion ? 0.6 : t * 0.07) + mx * 0.9, ax = 0.25 + my * 0.5;
      const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
      ctx.clearRect(0, 0, W, H);

      // stars
      ctx.fillStyle = "#fff";
      for (const s of stars) {
        project(s, Math.cos(ay * 0.3), Math.sin(ay * 0.3), cx, sx, proj);
        if (proj.z < -800) continue;
        ctx.globalAlpha = s.a * 0.6;
        ctx.fillRect(proj.x, proj.y, 1.2, 1.2);
      }

      nodes.forEach((n, i) => project(n, cy, sy, cx, sx, P[i]));
      // edges
      ctx.lineWidth = 1;
      for (const [a, b] of edges) {
        const A = P[a], B = P[b];
        const depth = 1 - ((A.z + B.z) / 2 + R) / (2 * R);
        ctx.globalAlpha = 0.08 + Math.max(0, depth) * 0.32;
        const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
        g.addColorStop(0, nodes[a].c); g.addColorStop(1, nodes[b].c);
        ctx.strokeStyle = g;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }
      // packets
      for (const p of packets) {
        if (!reduceMotion) p.t += p.v;
        if (p.t >= 1) {
          p.t = 0; const prev = p.from; p.from = p.to;
          const adj = nodes[p.from].adj.filter((j) => j !== prev);
          p.to = adj.length ? adj[Math.floor(Math.random() * adj.length)] : prev;
        }
        const A = P[p.from], B = P[p.to];
        const x = A.x + (B.x - A.x) * p.t, y = A.y + (B.y - A.y) * p.t;
        p.trail.push(x, y); if (p.trail.length > 16) p.trail.splice(0, 2);
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = nodes[p.to].c; ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < p.trail.length; k += 2) k ? ctx.lineTo(p.trail[k], p.trail[k + 1]) : ctx.moveTo(p.trail[k], p.trail[k + 1]);
        ctx.stroke();
        const sz = 22 * ((A.s + B.s) / 2);
        ctx.globalAlpha = 1;
        ctx.drawImage(sprites["#ffffff"], x - sz / 2, y - sz / 2, sz, sz);
      }
      // nodes, back to front
      const order = P.map((p, i) => i).sort((a, b) => P[b].z - P[a].z);
      for (const i of order) {
        const p = P[i], n = nodes[i];
        const depth = Math.max(0, Math.min(1, 1 - (p.z + R) / (2 * R)));
        const pulse = 1 + 0.15 * Math.sin(t * 2 + i);
        const sz = n.size * 7 * p.s * pulse;
        ctx.globalAlpha = 0.35 + depth * 0.65;
        ctx.drawImage(sprites[n.c], p.x - sz / 2, p.y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      if (!reduceMotion) requestAnimationFrame(frame);
    }
    const io = new IntersectionObserver(([en]) => {
      const was = running; running = en.isIntersecting;
      if (running && !was && !reduceMotion) requestAnimationFrame(frame);
    });
    io.observe(cvs);
    requestAnimationFrame(frame);
    if (reduceMotion) window.addEventListener("resize", () => requestAnimationFrame(frame));
  })();

  /* ---------------- Runtime simulator ---------------- */
  (() => {
    const svgHost = $("#runnerSvg");
    const spec = {
      nodes: [
        { id: "start", label: "START", x: 170, y: 50, kind: "terminal" },
        { id: "agent", label: "agent", x: 170, y: 200 },
        { id: "tools", label: "tools", x: 390, y: 200 },
        { id: "end", label: "END", x: 170, y: 355, kind: "terminal" },
      ],
      edges: [["start", "agent"], ["agent", "tools", { dashed: true, bend: -32 }], ["tools", "agent", { bend: -32 }], ["agent", "end", { dashed: true }]],
    };
    const tmp = document.createElement("div");
    tmp.innerHTML = renderGraph(spec, { w: 520, h: 410, nodeH: 46, charW: 11, padX: 40, minW: 110, radius: 12, flow: false, arrow: 7, glow: true,
      labels: { "agent>tools": ["tool_calls", 248, 132], "agent>end": ["no tool_calls", 182, 285] } });
    const svg = tmp.firstElementChild;
    svgHost.replaceWith(svg);
    svg.id = "runnerSvg";
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "ReAct agent graph: START to agent; agent to tools when there are tool calls; tools back to agent; agent to END otherwise.");
    const packet = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    packet.setAttribute("r", "7"); packet.setAttribute("class", "packet"); packet.style.opacity = 0;
    svg.appendChild(packet);

    const stateView = $("#stateView"), logView = $("#logView"), ckptView = $("#ckptView"), caption = $("#runCaption"), stepNo = $("#runStepNo");
    const human = { type: "human", content: "What's the weather in Paris?" };
    const steps = [
      { edge: ["start", "agent"], node: "agent", msg: { type: "ai", content: "", tool_calls: [{ name: "get_weather", args: { city: "Paris" }, id: "call_1" }] },
        caption: "<b>Super-step 1 · agent.</b> The LLM reads the messages channel and decides it needs a tool, emitting a <code>tool_call</code>. <code>tools_condition</code> sees it and routes to <b>tools</b>." },
      { edge: ["agent", "tools"], node: "tools", msg: { type: "tool", name: "get_weather", tool_call_id: "call_1", content: "It's always sunny in Paris!" },
        caption: "<b>Super-step 2 · tools.</b> <code>ToolNode</code> executes <code>get_weather</code> and writes a <code>ToolMessage</code>. The <code>add_messages</code> reducer appends it." },
      { edge: ["tools", "agent"], node: "agent", msg: { type: "ai", content: "It's sunny in Paris right now ☀️" },
        caption: "<b>Super-step 3 · agent.</b> The fixed edge loops back. With the observation in context, the LLM answers — no tool calls this time." },
      { edge: ["agent", "end"], node: "end", msg: null,
        caption: "<b>Done.</b> No tool calls → route to <code>END</code>. Every step was checkpointed under <code>thread_id=\"demo-1\"</code>, so the next message continues this conversation — or you can fork from any checkpoint." },
    ];
    let messages, idx, token = 0, busy = false;

    const jsonHL = (obj) => esc(JSON.stringify(obj, null, 2))
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="f">$1</span>$2')
      .replace(/:\s(&quot;.*?&quot;)/g, ': <span class="s">$1</span>');
    const ckptId = () => Math.random().toString(16).slice(2, 10);
    function addCkpt(step, src) {
      const li = document.createElement("li");
      li.innerHTML = `<span><b>step ${step}</b> · ${src}</span><span>${ckptId()}…</span>`;
      ckptView.prepend(li);
    }
    function addLog(html) {
      const li = document.createElement("li"); li.innerHTML = html; logView.prepend(li);
    }
    function render() { stateView.innerHTML = jsonHL({ messages }); }
    function setNode(id, cls) {
      $$(".g-node", svg).forEach((g) => g.classList.remove("active"));
      if (id) { const g = $(`.g-node[data-id="${id}"]`, svg); g.classList.add(cls || "active"); }
    }
    function reset() {
      token++; busy = false; idx = 0;
      messages = [human];
      logView.innerHTML = ""; ckptView.innerHTML = "";
      addCkpt(-1, "input");
      $$(".g-node", svg).forEach((g) => g.classList.remove("active", "done"));
      $$(".g-edge", svg).forEach((e) => e.classList.remove("hot"));
      packet.style.opacity = 0;
      stepNo.textContent = "–";
      caption.innerHTML = "Press <b>Run</b> to watch a ReAct agent answer “What's the weather in Paris?”.";
      $("#runPlay").textContent = "▶ Run";
      render();
    }
    async function travel(path, my) {
      const len = path.getTotalLength(), dur = reduceMotion ? 1 : 900, t0 = performance.now();
      path.classList.add("hot");
      packet.style.opacity = 1;
      await new Promise((res) => {
        const tick = (now) => {
          if (my !== token) return res();
          const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          const pt = path.getPointAtLength(e * len);
          packet.setAttribute("cx", pt.x); packet.setAttribute("cy", pt.y);
          k < 1 ? requestAnimationFrame(tick) : res();
        };
        requestAnimationFrame(tick);
      });
      packet.style.opacity = 0;
      setTimeout(() => path.classList.remove("hot"), 500);
    }
    async function step() {
      if (busy || idx >= steps.length) return false;
      busy = true;
      const my = token, s = steps[idx];
      const path = $(`.g-edge[data-from="${s.edge[0]}"][data-to="${s.edge[1]}"]`, svg);
      $$(".g-node", svg).forEach((g) => g.classList.remove("active"));
      await travel(path, my);
      if (my !== token) return false;
      setNode(s.node);
      caption.innerHTML = s.caption;
      if (s.msg) {
        stepNo.textContent = idx + 1;
        await sleep(reduceMotion ? 0 : 650);
        if (my !== token) return false;
        messages = messages.concat(s.msg);
        render();
        addLog(`<b>${s.node}</b> → {"messages": [${s.msg.type}${s.msg.tool_calls ? " tool_call get_weather" : ""}]}`);
        addCkpt(idx + 1, "loop");
        $(`.g-node[data-id="${s.node}"]`, svg).classList.add("done");
      } else {
        stepNo.textContent = "END";
        addLog("<b>__end__</b> · run complete");
        $("#runPlay").textContent = "↺ Replay";
      }
      idx++; busy = false;
      return true;
    }
    $("#runStep").addEventListener("click", () => { if (idx >= steps.length) reset(); step(); });
    $("#runReset").addEventListener("click", reset);
    $("#runPlay").addEventListener("click", async () => {
      if (idx >= steps.length || busy) reset();
      const my = token;
      while (idx < steps.length && my === token) {
        if (!(await step())) break;
        await sleep(reduceMotion ? 0 : 700);
      }
    });
    $$(".panel-tabs button").forEach((b) => b.addEventListener("click", () => {
      $$(".panel-tabs button").forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-selected", x === b); });
      $$(".runner-panel .panel").forEach((p) => (p.hidden = p.id !== "panel-" + b.dataset.panel));
    }));
    reset();
  })();
})();
