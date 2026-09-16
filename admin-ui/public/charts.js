// 사용량 대시보드 차트. 외부 차트 라이브러리 없이 인라인 SVG로 그린다.
// 색은 역할별 CSS 변수(--series-1 등)를 쓰고, 라이트/다크 값은 style에서 전환된다.

import { money, hasRemaining, remainingTipLine, rankValueText } from "./remaining-label.js";

const NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

// 공용 툴팁 (차트마다 만들지 않고 하나를 재사용)
let tip;
function showTip(html, x, y) {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "viz-tip";
    document.body.appendChild(tip);
  }
  tip.innerHTML = html;
  tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + "px";
  tip.style.top = (y - r.height - 12) + "px";
}
const hideTip = () => { if (tip) tip.style.display = "none"; };

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  // 마지막 눈금이 max를 덮도록 한 칸 더 올린다 (안 그러면 데이터가 축 위로 삐져나간다)
  for (let v = 0; v < max * 0.9999; v += step) ticks.push(v);
  ticks.push(ticks.length ? ticks[ticks.length - 1] + step : step);
  return ticks;
}

// 축·격자를 그리고 좌표 변환 함수를 돌려준다
function frame(svg, w, h, pad, maxY) {
  const ticks = niceTicks(maxY);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / top);
  for (const t of ticks) {
    svg.appendChild(el("line", {
      x1: pad.l, x2: w - pad.r, y1: y(t), y2: y(t),
      stroke: "var(--grid)", "stroke-width": 1,
    }));
    const lb = el("text", { x: pad.l - 8, y: y(t) + 4, "text-anchor": "end", class: "ax" });
    lb.textContent = money(t);
    svg.appendChild(lb);
  }
  return { y, top };
}

// ---- 일별 지출 (막대) ----
export function dailyBarChart(node, dates, values) {
  node.innerHTML = "";
  const w = node.clientWidth || 720, h = 220, pad = { l: 52, r: 12, t: 12, b: 26 };
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, role: "img" });
  const max = Math.max(...values, 0.0001);
  const { y } = frame(svg, w, h, pad, max);
  const plotW = w - pad.l - pad.r;
  const bw = Math.max(2, plotW / values.length - 2); // 막대 사이 2px 간격
  const base = h - pad.b;

  values.forEach((v, i) => {
    const x = pad.l + (plotW / values.length) * i + 1;
    const hgt = Math.max(v > 0 ? 2 : 0, base - y(v));
    if (hgt > 0) {
      // 데이터 끝(위쪽)만 4px 라운드, 바닥은 축에 붙인다
      const r = Math.min(4, bw / 2, hgt);
      const p = el("path", {
        d: `M${x},${base} L${x},${base - hgt + r} Q${x},${base - hgt} ${x + r},${base - hgt}
            L${x + bw - r},${base - hgt} Q${x + bw},${base - hgt} ${x + bw},${base - hgt + r} L${x + bw},${base} Z`,
        fill: "var(--series-1)",
      });
      svg.appendChild(p);
    }
    // 히트 영역은 막대보다 넓게
    const hit = el("rect", { x: pad.l + (plotW / values.length) * i, y: pad.t, width: plotW / values.length, height: base - pad.t, fill: "transparent" });
    hit.addEventListener("mousemove", (ev) => showTip(
      `<b>${dates[i]}</b><br>지출 ${money(v)}`, ev.clientX, ev.clientY));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });

  // x축 라벨은 5개 정도만 (겹침 방지)
  const stepX = Math.ceil(dates.length / 6);
  dates.forEach((d, i) => {
    if (i % stepX) return;
    const t = el("text", { x: pad.l + (plotW / values.length) * (i + 0.5), y: h - 8, "text-anchor": "middle", class: "ax" });
    t.textContent = shortDate(d);
    svg.appendChild(t);
  });
  svg.appendChild(el("line", { x1: pad.l, x2: w - pad.r, y1: base, y2: base, stroke: "var(--axis)", "stroke-width": 1 }));
  node.appendChild(svg);
}

// ---- 누적 지출 + 예측 (선) ----
export function cumulativeChart(node, dates, cumulative, futureDates, fc, budget) {
  node.innerHTML = "";
  const w = node.clientWidth || 720, h = 260, pad = { l: 52, r: 58, t: 14, b: 26 };
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, role: "img" });
  const future = fc ? fc.future : [];
  const allDates = dates.concat(futureDates.slice(0, future.length));
  const maxData = Math.max(...cumulative, ...future, 0.0001);
  // 예산이 실제 지출보다 지나치게 크면 선을 그리지 않는다.
  // 축을 예산에 맞추면 추세가 납작해져서 정작 보려던 변화가 안 보인다.
  const showBudget = budget != null && budget <= maxData * 3;
  const maxY = Math.max(maxData, showBudget ? budget : 0) * 1.05;
  const { y } = frame(svg, w, h, pad, maxY);
  const plotW = w - pad.l - pad.r;
  const x = (i) => pad.l + (plotW * i) / Math.max(1, allDates.length - 1);

  // 예산선 — 상태색이 아닌 중립 점선 + 라벨
  if (showBudget) {
    svg.appendChild(el("line", { x1: pad.l, x2: w - pad.r, y1: y(budget), y2: y(budget),
      stroke: "var(--limit)", "stroke-width": 2, "stroke-dasharray": "2 4" }));
    // 라벨은 왼쪽 끝에 둔다. 오른쪽엔 예측 끝점 값이 있어 겹친다.
    const t = el("text", { x: pad.l + 4, y: y(budget) - 5, class: "ax" });
    t.textContent = `예산 ${money(budget)}`;
    svg.appendChild(t);
  }

  const line = (pts, dash) => {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
    return el("path", { d, fill: "none", stroke: "var(--series-1)", "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round", ...(dash ? { "stroke-dasharray": "6 5" } : {}) });
  };

  const actual = cumulative.map((v, i) => [x(i), y(v)]);
  svg.appendChild(line(actual));
  if (future.length) {
    // 예측선은 실측 마지막 점에서 이어 그린다 (같은 값이므로 같은 색, 점선으로 구분)
    const fut = [[x(dates.length - 1), y(cumulative.at(-1))]]
      .concat(future.map((v, i) => [x(dates.length + i), y(v)]));
    svg.appendChild(line(fut, true));
    const last = fut.at(-1);
    svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: 4, fill: "var(--surface-1)", stroke: "var(--series-1)", "stroke-width": 2 }));
    const lb = el("text", { x: last[0], y: last[1] - 10, "text-anchor": "end", class: "lbl" });
    lb.textContent = money(future.at(-1));
    svg.appendChild(lb);
  }

  // 크로스헤어 + 툴팁
  const cross = el("line", { y1: pad.t, y2: h - pad.b, stroke: "var(--axis)", "stroke-width": 1, opacity: 0 });
  const dot = el("circle", { r: 4, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 });
  svg.appendChild(cross); svg.appendChild(dot);
  const overlay = el("rect", { x: pad.l, y: pad.t, width: plotW, height: h - pad.t - pad.b, fill: "transparent" });
  overlay.addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect();
    const rel = ((ev.clientX - box.left) / box.width) * w;
    const i = Math.max(0, Math.min(allDates.length - 1, Math.round(((rel - pad.l) / plotW) * (allDates.length - 1))));
    const isFuture = i >= dates.length;
    const v = isFuture ? future[i - dates.length] : cumulative[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", 1);
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(v)); dot.setAttribute("opacity", 1);
    showTip(`<b>${allDates[i]}</b><br>누적 ${money(v)}${isFuture ? " <i>(예측)</i>" : ""}`, ev.clientX, ev.clientY);
  });
  overlay.addEventListener("mouseleave", () => {
    hideTip(); cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0);
  });
  svg.appendChild(overlay);

  const stepX = Math.ceil(allDates.length / 7);
  allDates.forEach((d, i) => {
    if (i % stepX) return;
    const t = el("text", { x: x(i), y: h - 8, "text-anchor": "middle", class: "ax" });
    t.textContent = shortDate(d);
    svg.appendChild(t);
  });
  svg.appendChild(el("line", { x1: pad.l, x2: w - pad.r, y1: h - pad.b, y2: h - pad.b, stroke: "var(--axis)", "stroke-width": 1 }));
  node.appendChild(svg);
  return { budgetShown: showBudget };
}

// ---- 항목별 지출 (가로 막대). 예산이 있으면 예산을 트랙으로 깔고 지출을 채운다 ----
export function rankBarChart(node, items, { valueKey = "spend", labelKey = "alias", subKey = null, limit = 10 } = {}) {
  node.innerHTML = "";
  const data = items.slice(0, limit);
  if (!data.length) { node.innerHTML = '<p class="muted">기간 내 사용 기록 없음</p>'; return; }
  const w = node.clientWidth || 720;
  const rowH = 30, labelW = 150;
  // 잔여를 같이 쓰면 오른쪽 숫자 칸이 길어진다. 좁은 화면은 잔여만 두고 지출/예산은 툴팁에.
  const compact = w < 560;
  const valW = compact ? 118 : 196;
  const h = data.length * rowH + 8;
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, role: "img" });
  const plotW = w - labelW - valW;
  const max = Math.max(...data.map((d) => Math.max(d[valueKey], d.budget || 0)), 0.0001);

  data.forEach((d, i) => {
    const yTop = i * rowH + 6, bh = 14;
    const lb = el("text", { x: 0, y: yTop + 11, class: "lbl" });
    lb.textContent = d[labelKey];
    svg.appendChild(lb);
    if (subKey && d[subKey]) {
      const sub = el("text", { x: labelW - 10, y: yTop + 11, "text-anchor": "end", class: "ax" });
      sub.textContent = d[subKey];
      svg.appendChild(sub);
    }
    // 예산 트랙 — remaining이 있어도 트랙/초과 판정은 기존 budget을 쓴다
    if (d.budget) {
      svg.appendChild(el("rect", { x: labelW, y: yTop, width: (plotW * d.budget) / max, height: bh, rx: 4, fill: "var(--track)" }));
    }
    const bw = Math.max(2, (plotW * d[valueKey]) / max);
    const over = d.budget && d[valueKey] >= d.budget;
    svg.appendChild(el("rect", {
      x: labelW, y: yTop, width: bw, height: bh, rx: 4,
      fill: over ? "var(--status-critical)" : "var(--series-1)",
    }));
    const spendTxt = money(d[valueKey]);
    const val = el("text", { x: labelW + plotW + 8, y: yTop + 11, class: "lbl" });
    val.textContent = rankValueText(d, { valueKey, compact });
    svg.appendChild(val);

    const hit = el("rect", { x: 0, y: i * rowH, width: w, height: rowH, fill: "transparent" });
    hit.addEventListener("mousemove", (ev) => showTip(
      `<b>${d[labelKey]}</b>${d.team ? ` · ${d.team}` : ""}<br>지출 ${spendTxt}` +
      (d.budget ? `<br>예산 ${money(d.budget)} (${((d[valueKey] / d.budget) * 100).toFixed(0)}%)` : "") +
      (hasRemaining(d) ? `<br>${remainingTipLine(d.remaining)}` : "") +
      (d.requests != null ? `<br>요청 ${d.requests.toLocaleString()}회` : ""), ev.clientX, ev.clientY));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });
  node.appendChild(svg);
}
