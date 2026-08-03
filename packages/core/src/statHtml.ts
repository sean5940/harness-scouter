import { adviseAll } from "./growth.js";
import { renderRadarSvg, rankFill } from "./radar.js";
import type { StatEntry, StatWindow, TrendRow } from "./stats.js";

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
/* 팔레트는 계측기 판독창에서 가져왔다. 구조는 중립 슬레이트, 현재값은 청록,
   개인 최고는 황동. 등급색은 의미색이라 강조색과 분리한다. */
:root{
  --bg:#faf9f7; --panel:#f2f1ee; --line:#e2e0db;
  --text:#1a1d23; --dim:#666c78;
  --grid:#d5d7dd; --grid-soft:#e8e9ed; --structure:#8a93a3;
  --now:#2a7d70; --best:#a8802f; --track:#e7e6e2;
  --s:#a8791c; --a:#2f7d55; --b:#3a63a8; --c:#a8611f; --d:#a83a2e;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#101317; --panel:#171b21; --line:#242932;
  --text:#e8eaee; --dim:#8d939e;
  --grid:#2a2f38; --grid-soft:#1c212a; --structure:#4a5568;
  --now:#3fa896; --best:#c99a4e; --track:#1d222a;
  --s:#e0b352; --a:#4fa87a; --b:#6d94d6; --c:#c07a3e; --d:#cc6155;
}}
/* 뷰어 토글이 OS 설정을 이겨야 하므로 토큰을 다시 정의한다. */
:root[data-theme="dark"]{
  --bg:#101317; --panel:#171b21; --line:#242932;
  --text:#e8eaee; --dim:#8d939e;
  --grid:#2a2f38; --grid-soft:#1c212a; --structure:#4a5568;
  --now:#3fa896; --best:#c99a4e; --track:#1d222a;
  --s:#e0b352; --a:#4fa87a; --b:#6d94d6; --c:#c07a3e; --d:#cc6155;
}
:root[data-theme="light"]{
  --bg:#faf9f7; --panel:#f2f1ee; --line:#e2e0db;
  --text:#1a1d23; --dim:#666c78;
  --grid:#d5d7dd; --grid-soft:#e8e9ed; --structure:#8a93a3;
  --now:#2a7d70; --best:#a8802f; --track:#e7e6e2;
  --s:#a8791c; --a:#2f7d55; --b:#3a63a8; --c:#a8611f; --d:#a83a2e;
}
/* 레이더가 읽는 토큰 */
:root{--hs-grid:var(--grid); --hs-grid-muted:var(--grid-soft);
  --hs-baseline:var(--structure); --hs-current:var(--now); --hs-muted:var(--dim);
  --hs-text:var(--text); --hs-text-dim:var(--dim);
  --hs-rank-s:var(--s); --hs-rank-a:var(--a); --hs-rank-b:var(--b);
  --hs-rank-c:var(--c); --hs-rank-d:var(--d)}

*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Apple SD Gothic Neo',system-ui,sans-serif;
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.num{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
  font-variant-numeric:tabular-nums}
.wrap{max-width:780px;margin:0 auto;display:flex;flex-direction:column;gap:26px}

/* 판독창 머리 */
.readout{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding-bottom:16px;border-bottom:1px solid var(--line)}
.brand{font-size:11px;letter-spacing:.22em;color:var(--dim);font-weight:600;
  text-transform:uppercase;flex:1 0 100%}
.lv{font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;
  font-size:44px;font-weight:700;line-height:.9;letter-spacing:-.02em}
.lv small{font-size:14px;font-weight:500;color:var(--dim);letter-spacing:.08em;
  display:block;margin-bottom:4px}
.gradeChip{font-family:ui-monospace,Menlo,monospace;font-size:20px;font-weight:700;
  border:1.5px solid currentColor;border-radius:6px;padding:2px 12px;line-height:1.3}
.scope{margin-left:auto;text-align:right;color:var(--dim);font-size:12px;line-height:1.7}
.flag{color:var(--d);font-weight:600}

.chart{max-width:500px;margin:0 auto;width:100%}

.stats{display:flex;flex-direction:column}
.stat{padding:12px 0;border-bottom:1px solid var(--line)}
.stat:last-child{border-bottom:none}
.row{display:flex;align-items:center;gap:12px}
.name{flex:0 0 116px;font-weight:600;font-size:13.5px}
.q{color:var(--dim);font-size:11px;font-weight:400;display:block;margin-top:2px;
  letter-spacing:.01em}
.track{flex:1;min-width:80px;height:10px;background:var(--track);border-radius:2px;
  position:relative;overflow:hidden}
.fill{position:absolute;left:0;top:0;bottom:0;background:var(--now);border-radius:2px}
.band{position:absolute;top:0;bottom:0;background:var(--structure);opacity:.28}
.tick{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--best)}
.val{flex:0 0 32px;text-align:right;font-weight:600;font-size:14px}
.rk{flex:0 0 24px;text-align:center;font-weight:700;font-size:13px}
.parts{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;padding-left:128px}
.part{font-size:11px;color:var(--dim);background:var(--panel);border-radius:3px;
  padding:3px 8px;white-space:nowrap;border:1px solid var(--line)}
.part b{color:var(--text);font-weight:600}
.part .n{opacity:.65;margin-left:2px}

.guide{display:flex;flex-direction:column;gap:10px}
.guide h2{font-size:11px;letter-spacing:.18em;color:var(--dim);margin:0;
  font-weight:600;text-transform:uppercase}
.adv{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px}
.adv .top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.adv .nm{font-weight:700;font-size:14px}
.adv .gain{font-size:12px;color:var(--now);font-weight:600}
.adv .bn{font-size:11.5px;color:var(--dim);margin-left:auto}
.adv .crit{font-size:12px;color:var(--dim);line-height:1.6;
  padding-left:11px;border-left:2px solid var(--line)}
.adv ul{margin:9px 0 0;padding-left:17px;font-size:12.5px;line-height:1.65}
.adv li{margin:3px 0}
.adv li.no{color:var(--d)}
.adv li.no::marker{content:"× "}
.trend table{width:100%;border-collapse:collapse;font-size:12.5px;
  background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
.trend th{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--dim);font-weight:600;text-align:left;padding:9px 12px;
  border-bottom:1px solid var(--line)}
.trend td{padding:6px 12px;border-bottom:1px solid var(--line)}
.trend tr:last-child td{border-bottom:none}
.trend .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.trend .dim{color:var(--dim)}
.trend .statRow td{font-weight:700;background:color-mix(in srgb,var(--line) 30%,transparent)}
.trend .compRow td{color:var(--fg)}
.trend .thin td{opacity:.45}
.trend .up{color:var(--now);font-weight:700}
.trend .down{color:var(--d);font-weight:700}
.trend .flat{color:var(--dim)}
.trend .crit{font-size:11.5px;color:var(--dim);line-height:1.6;
  padding-left:11px;border-left:2px solid var(--line)}

.foot{color:var(--dim);font-size:11.5px;line-height:1.8;padding-top:16px;
  border-top:1px solid var(--line)}
@media (max-width:560px){
  .name{flex-basis:96px}
  .parts{padding-left:0}
  .scope{margin-left:0;text-align:left;flex:1 0 100%}
}
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
          high - low,
        ).toFixed(1)}%"></span>`;
  const bestTick =
    stat.best === null
      ? ""
      : `<span class="tick" style="left:${Math.min(99.5, stat.best).toFixed(
          1,
        )}%"></span>`;

  const parts = stat.components
    .map(
      (c) =>
        `<span class="part">${escapeHtml(c.label)} <b class="num">${
          c.value === null ? "—" : (c.value * 100).toFixed(0)
        }</b><span class="n num">n=${c.denominator.toLocaleString()}</span></span>`,
    )
    .join("");

  return `<div class="stat">
  <div class="row">
    <div class="name">${escapeHtml(stat.label)}<span class="q">${escapeHtml(
      stat.question,
    )}</span></div>
    <div class="track">${band}<span class="fill" style="width:${Math.max(
      0,
      Math.min(100, score),
    ).toFixed(1)}%"></span>${bestTick}</div>
    <div class="val num">${num(stat.score)}</div>
    <div class="rk num" style="color:${gray ? "var(--dim)" : rankFill(stat.rank)}">${stat.rank}</div>
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
/** 분모가 이보다 얇으면 차이를 표시하되 판단 근거로는 쓰지 않는다고 밝힌다. */
const TREND_THIN_DENOMINATOR = 100;

/**
 * 초기 절반과 최근 절반의 비교.
 *
 * 정의를 고치면 점수가 움직이는데 그건 측정이 바뀐 것이지 행동이 바뀐 게 아니다.
 * 같은 정의로 시기를 갈라야 그 둘이 분리된다.
 */
function renderTrend(rows: TrendRow[]): string {
  if (rows.length === 0) return "";
  const cell = (v: number | null) => (v === null ? "—" : v.toFixed(1));
  const arrow = (d: number | null) => {
    if (d === null) return "";
    if (Math.abs(d) < 2) return "flat";
    return d > 0 ? "up" : "down";
  };
  return `<div class="guide trend">
  <h2>성장 · 같은 정의로 초기 절반 대 최근 절반</h2>
  <table>
    <thead><tr><th>항목</th><th>초기</th><th>최근</th><th>변화</th><th>분모</th></tr></thead>
    <tbody>
    ${rows
      .map((r) => {
        const thin =
          r.parent !== null && r.denominator < TREND_THIN_DENOMINATOR;
        return `<tr class="${r.parent === null ? "statRow" : "compRow"}${thin ? " thin" : ""}">
        <td>${r.parent === null ? "" : "&nbsp;&nbsp;&nbsp;"}${escapeHtml(r.label)}</td>
        <td class="n">${cell(r.early)}</td>
        <td class="n">${cell(r.late)}</td>
        <td class="n ${arrow(r.delta)}">${r.delta === null ? "—" : `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)}`}</td>
        <td class="n dim">${r.denominator.toLocaleString()}</td>
      </tr>`;
      })
      .join("")}
    </tbody>
  </table>
  <div class="crit">정의를 바꾸면 점수가 움직이지만 그건 측정이 바뀐 것입니다.
  같은 정의로 시기를 갈라야 행동 변화만 남습니다. 회색 줄은 분모가 ${TREND_THIN_DENOMINATOR}건 미만이라
  차이를 판단 근거로 쓰지 않습니다.</div>
</div>`;
}

export function renderStatHtml(
  window: StatWindow,
  options: { allTime?: boolean; trend?: TrendRow[] } = {},
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
<div class="readout">
  <span class="brand">Harness Scouter</span>
  <span class="lv"><small>LEVEL</small>${window.level}</span>
  <span class="gradeChip" style="color:${gray ? "var(--dim)" : rankFill(window.overallRank)}">${window.overallRank}</span>
  <span class="scope">${scope} · 세션 ${window.sessionCount}개<br>
    ${window.startedAt.slice(0, 10)} ~ ${window.endedAt.slice(0, 10)}<br>
    계측 커버리지 <span class="num">${coverage}</span>${gray ? ' · <span class="flag">판정 보류</span>' : ""}</span>
</div>
<div class="chart">${renderRadarSvg(window.stats, { grayedOut: gray })}</div>
<div class="stats">${window.stats.map((stat) => renderStat(stat, gray)).join("\n")}</div>
${
  gray
    ? ""
    : `<div class="guide">
  <h2>성장 가이드${options.allTime === true ? " · 병목 해소 이득 순" : " · 개인 최고까지의 격차 순"}</h2>
  ${adviseAll(window.stats, { allTime: options.allTime === true })
    .filter((a) =>
      options.allTime === true
        ? (a.bottleneckGain ?? 0) >= 1
        : (a.gapToBest ?? 0) >= 1,
    )
    .slice(0, 3)
    .map((a) => {
      const c = a.criterion;
      return `<div class="adv">
      <div class="top">
        <span class="nm">${escapeHtml(a.label)}</span>
        <span>${options.allTime === true ? num(a.score) : `${num(a.score)} → 최고 ${num(a.best)}`}</span>
        <span class="gap">병목 해소 시 +${num(a.bottleneckGain)}</span>
        <span class="bn">병목 ${a.bottleneck === null ? "—" : escapeHtml(a.bottleneck.label)} ${
          a.bottleneck?.value == null
            ? ""
            : (a.bottleneck.value * 100).toFixed(0)
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
</div>`
}
${gray ? '<div class="guide"><h2>성장 가이드</h2><div class="adv">계측 커버리지가 임계 아래라 이 구간의 값을 판정하지 않습니다. 커버리지가 회복된 구간에서 다시 보세요.</div></div>' : ""}
${renderTrend(options.trend ?? [])}
<div class="foot">
굵은 육각형은 100점 경계, 파선은 개인 최고, 채운 면은 지금입니다.
막대 안 옅은 띠는 통상 범위(p25~p75), 세로 눈금은 개인 최고입니다.<br>
${rankBasis} 직전 구간 대비 변화는 표시하지 않습니다. 구간 간 상관이 0 근처라 잡음이기 때문입니다.
</div>
</div></body></html>`;
}
