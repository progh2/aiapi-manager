// 그림 안내서 공용 스크립트. 로그인 없이 열리는 정적 페이지라 서버에서는 접속 주소만 받는다(/guide/config.json).
// - data-fill="site|proxy|base" 자리와 코드 속 __SITE__ · __PROXY__ · __BASE__ 를 이 학교 주소로 바꾼다
// - 코드 상자의 [복사], 목차 만들기, 그림 크게 보기, Windows/Mac 고르기
(() => {
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // http(학교 내부 IP) 에서는 clipboard API 가 막혀 예전 방식으로 복사한다.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // ---------------------------------------------------------------- 주소 채우기
  const tpl = new Map();
  function fill(addr) {
    for (const el of $$("[data-fill]")) el.textContent = addr[el.dataset.fill] || el.textContent;
    for (const pre of $$(".code pre")) {
      if (!tpl.has(pre)) tpl.set(pre, pre.textContent);
      pre.textContent = tpl.get(pre).replace(/__SITE__/g, addr.site).replace(/__PROXY__/g, addr.proxy).replace(/__BASE__/g, addr.base);
    }
  }
  const fromFile = location.protocol === "file:";
  const guess = (port) => `${location.protocol}//${location.hostname}:${port || 4000}`;
  const addrOf = (cfg) => {
    const proxy = String((cfg && cfg.proxy_url) || guess(cfg && cfg.proxy_port)).replace(/\/+$/, "");
    return { site: location.origin, proxy, base: `${proxy}/v1` };
  };
  if (fromFile) {
    fill({ site: "http://학교서버주소:3000", proxy: "http://학교서버주소:4000", base: "http://학교서버주소:4000/v1" });
  } else {
    fill(addrOf(null));
    fetch("/guide/config.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => { if (cfg) fill(addrOf(cfg)); })
      .catch(() => {});
  }

  // ---------------------------------------------------------------- 복사 버튼
  for (const box of $$(".code")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "복사";
    btn.onclick = async () => {
      const ok = await copyText(box.querySelector("pre").textContent);
      btn.textContent = ok ? "복사됨 ✓" : "직접 선택해 복사하세요";
      btn.classList.toggle("done", ok);
      setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("done"); }, 2000);
    };
    box.appendChild(btn);
  }

  // ---------------------------------------------------------------- 목차
  const toc = document.querySelector(".g-toc ol");
  const heads = $$("main section.g-sec[id] > h2");
  if (toc) {
    toc.innerHTML = heads.map((h) => {
      const no = h.querySelector(".no");
      const text = [...h.childNodes].filter((n) => n !== no).map((n) => n.textContent).join("").trim();
      return `<li><a href="#${h.parentElement.id}">${no ? `${no.textContent}. ` : ""}${text}</a></li>`;
    }).join("");
    const links = new Map($$("a", toc).map((a) => [a.getAttribute("href").slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links.values()) a.classList.remove("on");
        const a = links.get(e.target.id);
        if (a) a.classList.add("on");
      }
    }, { rootMargin: "-80px 0px -70% 0px" });
    for (const h of heads) io.observe(h.parentElement);
  }

  // ---------------------------------------------------------------- 그림 크게 보기
  for (const img of $$("figure.shot img")) {
    img.addEventListener("click", () => {
      const z = document.createElement("div");
      z.className = "zoom";
      z.setAttribute("role", "dialog");
      z.setAttribute("aria-label", img.alt || "그림 크게 보기");
      z.innerHTML = `<img src="${img.currentSrc || img.src}" alt="">`;
      const close = () => { z.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (ev) => { if (ev.key === "Escape") close(); };
      z.onclick = close;
      document.addEventListener("keydown", onKey);
      document.body.appendChild(z);
    });
  }

  // ---------------------------------------------------------------- Windows / Mac
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const setOs = (os) => {
    for (const b of $$(".os [data-os]")) b.setAttribute("aria-pressed", String(b.dataset.os === os));
    for (const el of $$("[data-os-only]")) el.hidden = el.dataset.osOnly !== os;
  };
  for (const b of $$(".os [data-os]")) b.onclick = () => setOs(b.dataset.os);
  if ($$(".os").length) setOs(isMac ? "mac" : "windows");

  // 인쇄할 때는 접힌 질문도 펼친다.
  window.addEventListener("beforeprint", () => { for (const d of $$("details")) d.open = true; });
  for (const b of $$("[data-print]")) b.onclick = () => window.print();
})();
