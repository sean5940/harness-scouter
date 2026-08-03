import { adviseAll } from "./growth.js";
import { renderRadarSvg, rankFill } from "./radar.js";
import type { StatEntry, StatWindow } from "./stats.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function num(value: number | null, digits = 0): string {
  return value === null ? "—" : value.toFixed(digits);
}

const STYLE = `
:root{--hs-bg:#fff;--hs-text:#1b1f2a;--hs-text-dim:#6b7280;--hs-line:#e6e8ef;
--hs-grid:#c7cbe0;--hs-grid-muted:#e3e5ec;--hs-baseline:#2c3e91;--hs-current:#a8905c;
--hs-muted:#b6bac6;--hs-track:#eef0f6;--hs-panel:#f7f8fc;
--hs-rank-s:#b8860b;--hs-rank-a:#1a7f4b;--hs-rank-b:#2c3e91;--hs-rank-c:#a86423;--hs-rank-d:#b3352c}
@media (prefers-color-scheme:dark){:root{--hs-bg:#14161c;--hs-text:#e7e9f0;--hs-text-dim:#9aa0ae;
--hs-line:#272a35;--hs-grid:#3a4058;--hs-grid-muted:#282c38;--hs-baseline:#7b90e8;--hs-current:#d9bd7d;
--hs-muted:#565b6a;--hs-track:#232630;--hs-panel:#1a1d25;
--hs-rank-s:#e8c162;--hs-rank-a:#54c68a;--hs-rank-b:#8fa2f0;--hs-rank-c:#e0a05c;--hs-rank-d:#e8776c}}
*{box-sizing:border-box}
body{margin:0;padding:26px 20px 56px;background:var(--hs-bg);color:var(--hs-text);
font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Apple SD Gothic Neo',sans-serif;
font-size:14px;line-height:1.5}
.wrap{max-width:760px;margin:0 auto}
.head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:2px}
.title{font-size:13px;letter-spacing:.14em;color:var(--hs-text-dim);font-weight:600}
.level{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1}
.grade{font-size:26px;font-weight:800}
.meta{color:var(--hs-text-dim);font-size:12.5px;margin-bottom:4px}
.warn{color:var(--hs-rank-d);font-weight:600}
.chart{max-width:520px;margin:2px auto 10px}
.stat{padding:11px 0;border-bottom:1px solid var(--hs-line)}
.stat:last-child{border-bottom:none}
.row{display:flex;align-items:center;gap:10px}
.name{flex:0 0 108px;font-weight:600}
.q{color:var(--hs-text-dim);font-size:11.5px;font-weight:400;display:block;margin-top:1px}
.track{flex:1;height:9px;background:var(--hs-track);border-radius:5px;position:relative;overflow:hidden}
.fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:var(--hs-current)}
.band{position:absolute;top:0;bottom:0;background:var(--hs-baseline);opacity:.16}
.tick{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--hs-baseline);opacity:.75}
.score{flex:0 0 34px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.rank{flex:0 0 20px;text-align:center;font-weight:800}
.parts{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0 0 118px}
.part{font-size:11.5px;color:var(--hs-text-dim);background:var(--hs-panel);
border-radius:5px;padding:3px 8px;white-space:nowrap}
.part b{color:var(--hs-text);font-weight:600;font-variant-numeric:tabular-nums}
.foot{margin-top:22px;padding-top:14px;border-top:1px solid var(--hs-line);
color:var(--hs-text-dim);font-size:11.5px;line-height:1.7}
.guide{margin-top:26px;padding-top:18px;border-top:1px solid var(--hs-line)}
.guide h2{font-size:13px;letter-spacing:.1em;color:var(--hs-text-dim);margin:0 0 12px;font-weight:600}
.adv{background:var(--hs-panel);border-radius:8px;padding:12px 14px;margin-bottom:10px}
.adv .top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.adv .nm{font-weight:700}
.adv .gap{font-size:12px;color:var(--hs-rank-a);font-weight:600}
.adv .bn{font-size:12px;color:var(--hs-text-dim);margin-left:auto}
.adv .crit{font-size:12px;color:var(--hs-text-dim);margin:7px 0 2px}
.adv ul{margin:6px 0 0;padding-left:16px;font-size:12.5px}
.adv li{margin:2px 0}
.adv li.no{color:var(--hs-rank-d)}
`;

function renderStat(stat: StatEntry, gray: boolean): string {
  const score = stat.score ?? 0;
  const low = stat.typicalLow;
  const high = stat.typicalHigh;
  const band =
    low === null || high === null
      ? ""
      : `<span class="band" style="left:${low.toFixed(1)}%;width:${Math.max(
          0.5,
          high - low
        ).toFixed(1)}%"></span>`;
  const bestTick =
    stat.best === null
      ? ""
      : `<span class="tick" style="left:${Math.min(99.5, stat.best).toFixed(
          1
        )}%"></span>`;

  const parts = stat.components
    .map(
      (c) =>
        `<span class="part">${escapeHtml(c.label)} <b>${
          c.value === null ? "—" : (c.value * 100).toFixed(0)
        }</b> <span style="opacity:.7">n=${c.denominator.toLocaleString()}</span></span>`
    )
    .join("");

  return `<div class="stat">
  <div class="row">
    <div class="name">${escapeHtml(stat.label)}<span class="q">${escapeHtml(
    stat.question
  )}</span></div>
    <div class="track">${band}<span class="fill" style="width:${Math.max(
    0,
    Math.min(100, score)
  ).toFixed(1)}%"></span>${bestTick}</div>
    <div class="score">${num(stat.score)}</div>
    <div class="rank" style="color:${gray ? "var(--hs-muted)" : rankFill(stat.rank)}">${stat.rank}</div>
  </div>
  <div class="parts">${parts}</div>
</div>`;
}

/**
 * 능력치 스테이터스 창.
 *
 * 직전 구간 대비 화살표를 그리지 않는다. M0.5에서 구간 간 lag-1 자기상관이 0 근처로
 * 나와, 이웃 구간과의 차이는 신호가 아니라 잡음이다(설계 8.1). 대신 지금 값과
 * 통상 범위(막대 안 옅은 띠), 개인 최고(세로 눈금)를 함께 보여준다.
 *
 * Webview에 그대로 넣을 수 있도록 외부 리소스 없이 한 파일로 만든다 (설계 7절 CSP 제약).
 */
export function renderStatHtml(
  window: StatWindow,
  options: { allTime?: boolean } = {}
): string {
  const gray = !window.judgeable;
  const scope =
    options.allTime === true ? "전수 집계" : `구간 #${window.periodIndex}`;
  const coverage =
    window.coverage === null ? "—" : `${(window.coverage * 100).toFixed(0)}%`;

  const rankBasis =
    options.allTime === true
      ? "전수 집계라 등급을 절대 점수로 매겼습니다."
      : `등급은 내 이력 ${window.historyWindows}개 창에서의 위치입니다. 절대 기준이 아닙니다.`;

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>Harness Scouter</title><style>${STYLE}</style></head>
<body><div class="wrap">
<div class="head">
  <span class="title">HARNESS SCOUTER</span>
  <span class="level">Lv.${window.level}</span>
  <span class="grade" style="color:${rankFill(window.overallRank)}">${
    window.overallRank
  }</span>
</div>
<div class="meta">${scope} · ${window.startedAt.slice(
    0,
    10
  )} ~ ${window.endedAt.slice(0, 10)} · 세션 ${
    window.sessionCount
  }개 · 계측 커버리지 ${coverage}${
    gray ? ' · <span class="warn">커버리지 미달로 판정 보류</span>' : ""
  }</div>
<div class="chart">${renderRadarSvg(window.stats, { grayedOut: gray })}</div>
${window.stats.map((stat) => renderStat(stat, gray)).join("\n")}
${gray ? "" : `<div class="guide">
  <h2>성장 가이드 · 개인 최고까지의 격차 순</h2>
  ${adviseAll(window.stats)
    .filter((a) => (a.gapToBest ?? 0) >= 1)
    .slice(0, 3)
    .map((a) => {
      const c = a.criterion;
      return `<div class="adv">
      <div class="top">
        <span class="nm">${escapeHtml(a.label)}</span>
        <span>${num(a.score)} → 최고 ${num(a.best)}</span>
        <span class="gap">+${num(a.gapToBest)} 여지</span>
        <span class="bn">병목 ${a.bottleneck === null ? "—" : escapeHtml(a.bottleneck.label)} ${
          a.bottleneck?.value == null ? "" : (a.bottleneck.value * 100).toFixed(0)
        }</span>
      </div>
      ${c === null ? "" : `<div class="crit">${escapeHtml(c.measures)}</div>`}
      ${
        c === null
          ? ""
          : `<ul>${c.actions.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}${c.antipatterns
              .map((x) => `<li class="no">${escapeHtml(x)}</li>`)
              .join("")}</ul>`
      }
    </div>`;
    })
    .join("")}
</div>`}
${gray ? '<div class="guide"><h2>성장 가이드</h2><div class="adv">계측 커버리지가 임계 아래라 이 구간의 값을 판정하지 않습니다. 커버리지가 회복된 구간에서 다시 보세요.</div></div>' : ""}
<div class="foot">
굵은 육각형은 100점 경계, 파선은 개인 최고, 채운 면은 지금입니다.
막대 안 옅은 띠는 통상 범위(p25~p75), 세로 눈금은 개인 최고입니다.<br>
${rankBasis} 직전 구간 대비 변화는 표시하지 않습니다. 구간 간 상관이 0 근처라 잡음이기 때문입니다.
</div>
</div></body></html>`;
}
