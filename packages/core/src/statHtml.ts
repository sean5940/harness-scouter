import {
  adviseAll,
  COMPONENT_CRITERIA,
  OBJECTIVE_LABELS,
  CONTAMINATION_LABELS,
} from "./growth.js";
import { renderRadarSvg, rankFill } from "./radar.js";
import { validityState } from "./validity.js";
import type { ComponentKey, StatEntry, StatWindow, TrendRow } from "./stats.js";
import { L, t, tList, type Lang } from "./i18n.js";
import {
  STAGE_LABELS,
  type HarnessCoverage,
  type CoherenceReport,
  type LifecycleStage,
} from "./harness.js";

/** 스탯 창이 함께 보여줄 하네스 구조 요약. */
export interface HarnessView {
  sensorCount: number;
  autoCount: number;
  guideCount: number;
  coverage: HarnessCoverage;
  coherence: CoherenceReport;
}

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
.part .rel{margin-left:5px;padding-left:5px;border-left:1px solid var(--line);opacity:.8}

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
.rubric table{width:100%;border-collapse:collapse;font-size:12px;
  background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
.rubric th{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);
  font-weight:600;text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
.rubric td{padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.rubric tr:last-child td{border-bottom:none}
.rubric .dim{color:var(--dim);white-space:nowrap}
.rubric .basis{color:var(--dim);font-size:11.5px;line-height:1.55}
.rubric .obj{font-weight:700;white-space:nowrap}
.rubric .obj.ceiling{color:var(--now)}
.rubric .obj.directional{color:var(--fg)}
.rubric .obj.guarded{color:var(--best)}
.rubric .flag{display:inline-block;font-size:10.5px;color:var(--d);
  border:1px solid var(--line);border-radius:3px;padding:1px 5px;margin:0 3px 3px 0;white-space:nowrap}
.rubric .clean{font-size:10.5px;color:var(--now);font-weight:600}
.rubric .crit{font-size:11.5px;color:var(--dim);line-height:1.65;
  padding-left:11px;border-left:2px solid var(--line)}
.harness .hbox{background:var(--panel);border:1px solid var(--line);border-radius:6px;
  padding:14px 16px;display:flex;flex-direction:column;gap:9px}
.harness .hrow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.harness .lbl{flex:0 0 44px;font-size:11px;letter-spacing:.1em;color:var(--dim);
  text-transform:uppercase;font-weight:600}
.harness .cell{font-size:11.5px;color:var(--dim);background:var(--bg);
  border:1px solid var(--line);border-radius:3px;padding:3px 9px;white-space:nowrap}
.harness .cell b{color:var(--text);font-size:13px;font-weight:700;
  font-variant-numeric:tabular-nums;margin-right:5px}
.harness .crit{font-size:11.5px;color:var(--dim);line-height:1.65;
  padding-left:11px;border-left:2px solid var(--line)}

.foot{color:var(--dim);font-size:11.5px;line-height:1.8;padding-top:16px;
  border-top:1px solid var(--line)}
@media (max-width:560px){
  .name{flex-basis:96px}
  .parts{padding-left:0}
  .scope{margin-left:0;text-align:left;flex:1 0 100%}
}
`;

function renderStat(stat: StatEntry, gray: boolean, lang: Lang): string {
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

  // 일부만으로 낸 점수면 그 사실을 붙인다. 없으면 셋 중 하나로 낸 점수를 셋 다 잰 것으로 읽는다.
  const partial =
    stat.score !== null && stat.scoredCount < stat.scorableCount
      ? `<span class="partial">${escapeHtml(
          t(
            L(
              `${stat.scorableCount}개 중 ${stat.scoredCount}개로 냈습니다`,
              `scored from ${stat.scoredCount} of ${stat.scorableCount}`,
            ),
            lang,
          ),
        )}</span>`
      : "";

  const parts = stat.components
    .map(
      (c) =>
        `<span class="part${c.displayOnly === true ? " displayOnly" : ""}">${escapeHtml(t(c.label, lang))}${c.displayOnly === true ? ` <span class="tag">${escapeHtml(t(L("표시", "display"), lang))}</span>` : ""} <b class="num">${
          c.value === null ? "—" : (c.value * 100).toFixed(0)
        }</b><span class="n num">n=${c.denominator.toLocaleString()}</span>${
          c.crossPeriodStability == null
            ? ""
            : `<span class="rel num" title="${t(
                L(
                  "구간 간 안정성. 이력에서 이 값이 얼마나 덜 흔들렸나",
                  "Stability across periods. How little this value moved in the history",
                ),
                lang,
              )}">±${(c.crossPeriodStability * 100).toFixed(0)}</span>`
        }</span>`,
    )
    .join("");

  return `<div class="stat">
  <div class="row">
    <div class="name">${escapeHtml(t(stat.label, lang))}<span class="q">${escapeHtml(
      t(stat.question, lang),
    )}</span></div>
    <div class="track">${band}<span class="fill" style="width:${Math.max(
      0,
      Math.min(100, score),
    ).toFixed(1)}%"></span>${bestTick}</div>
    <div class="val num">${num(stat.score)}</div>
    <div class="rk num" style="color:${gray ? "var(--dim)" : rankFill(stat.rank)}">${stat.rank}</div>
  </div>
  <div class="parts">${partial}${parts}</div>
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
/**
 * 구성요소마다 무엇을 기준으로 평가하는지.
 *
 * 등급을 그 사람의 이력 백분위로만 매기면 다른 사람 하네스를 평가할 수 없다.
 * 목표가 어디서 오는지(objective)와 무엇이 비교를 깨는지(contamination)를 함께 적어야
 * 이 점수를 남의 하네스에 대고 쓸 수 있는지 판단할 수 있다.
 */
function renderRubric(stats: StatEntry[], lang: Lang): string {
  // 중복 판정과 기준표 조회를 모두 key 로 한다. 표시 문자열로 하면 언어가 바뀔 때
  // 조회가 통째로 빗나가고, 화면은 빈 표를 조용히 낸다.
  const rows = stats.flatMap((stat) =>
    stat.components.map((c) => ({
      stat: stat.label,
      key: c.key,
      component: c.label,
    })),
  );
  const seen = new Set<ComponentKey>();
  const body = rows
    .map(({ stat, key, component }) => {
      if (seen.has(key)) return "";
      seen.add(key);
      const criterion = COMPONENT_CRITERIA[key];
      if (criterion === undefined) return "";
      const flags =
        criterion.contamination.length === 0
          ? `<span class="clean">${escapeHtml(t(L("비교 가능", "Comparable"), lang))}</span>`
          : criterion.contamination
              .map(
                (f) =>
                  `<span class="flag">${escapeHtml(t(CONTAMINATION_LABELS[f], lang))}</span>`,
              )
              .join("");
      return `<tr>
      <td class="dim">${escapeHtml(t(stat, lang))}</td>
      <td>${escapeHtml(t(component, lang))}</td>
      <td><span class="obj ${criterion.objective}">${escapeHtml(t(OBJECTIVE_LABELS[criterion.objective], lang))}</span></td>
      <td>${flags}</td>
      <td class="basis">${escapeHtml(t(criterion.targetBasis, lang))}</td>
    </tr>`;
    })
    .join("");
  if (body === "") return "";
  return `<div class="guide rubric">
  <h2>${t(
    L(
      "평가 기준 · 이 점수를 남의 하네스에 쓸 수 있는가",
      "Rubric · can this score be used on someone else's harness",
    ),
    lang,
  )}</h2>
  <table>
    <thead><tr><th>${t(L("능력치", "Stat"), lang)}</th><th>${t(
      L("구성요소", "Component"),
      lang,
    )}</th><th>${t(L("목표", "Objective"), lang)}</th><th>${t(
      L("비교 가능성", "Comparability"),
      lang,
    )}</th><th>${t(L("근거", "Basis"), lang)}</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <div class="crit">${t(
    L(
      `오염 표시가 하나라도 있으면 사람 간 비교에 쓰지 않습니다.
  <b>훅 설치가 값을 움직임</b>은 차단된 호출이 축 계산에서 빠져 방어를 깔수록 점수가 오른다는 뜻이고,
  <b>도구 이름에 묶임</b>은 이름이 다른 하네스에서 그 활동이 계상에서 통째로 빠진다는 뜻입니다.
  <b>양극단 주의</b>는 최대화 대상이 아니라 종합 점수에서 뺍니다.`,
      `Do not use this for comparison between people if even one contamination flag is present.
  <b>Installing hooks moves the value</b> means blocked calls drop out of the axis, so the more guards you install the higher the score.
  <b>Bound to tool names</b> means a harness with different names loses that activity from the count entirely.
  <b>Watch both extremes</b> is not something to maximize, and is left out of the overall score.`,
    ),
    lang,
  )}</div>
</div>`;
}

/**
 * 하네스 구조. 행동 지표만으로는 못 하는 것을 여기서 한다.
 *
 * "차단 0건"이 센서가 좋아서인지 없어서인지는 이 목록을 봐야 갈린다.
 * 축 이름은 Martin Fowler 의 harness engineering 에서 가져왔다.
 */
function renderHarness(view: HarnessView | undefined, lang: Lang): string {
  if (view === undefined) return "";
  const { coverage, coherence, sensorCount, guideCount, autoCount } = view;
  const stage = (Object.keys(coverage.byStage) as LifecycleStage[])
    .map(
      (k) =>
        `<span class="cell"><b>${coverage.byStage[k]}</b>${escapeHtml(t(STAGE_LABELS[k], lang))}</span>`,
    )
    .join("");
  return `<div class="guide harness">
  <h2>${t(
    L(
      "하네스 구조 · 행동이 아니라 하네스 자체",
      "Harness structure · the harness itself, not behavior",
    ),
    lang,
  )}</h2>
  <div class="hbox">
    <div class="hrow"><span class="lbl">${t(L("센서", "Sensors"), lang)}</span>
      <span class="cell"><b>${sensorCount}</b>${t(L("전체", "total"), lang)}</span>
      <span class="cell"><b>${autoCount}</b>${t(L("자동 발동", "auto-firing"), lang)}</span>
      <span class="cell"><b>${sensorCount - autoCount}</b>${t(L("수동 호출", "called by hand"), lang)}</span>
      <span class="cell"><b>${guideCount}</b>${t(L("가이드", "guides"), lang)}</span></div>
    <div class="hrow"><span class="lbl">${t(L("방향", "Direction"), lang)}</span>
      <span class="cell"><b>${coverage.byDirection.feedforward}</b>${t(L("행동 전 조종", "steer before acting"), lang)}</span>
      <span class="cell"><b>${coverage.byDirection.feedback}</b>${t(L("행동 후 관찰", "observe after acting"), lang)}</span></div>
    <div class="hrow"><span class="lbl">${t(L("실행", "Execution"), lang)}</span>
      <span class="cell"><b>${coverage.byExecution.computational}</b>${t(L("결정론적", "deterministic"), lang)}</span>
      <span class="cell"><b>${coverage.byExecution.inferential}</b>${t(L("의미론적", "semantic"), lang)}</span></div>
    <div class="hrow"><span class="lbl">${t(L("단계", "Stage"), lang)}</span>${stage}</div>
  </div>
  <div class="crit">${t(
    L(
      `규칙 문서 ${coherence.documentsChecked}개에서 훅 ${coherence.sensorsChecked}종을 확인했습니다.`,
      `Checked ${coherence.sensorsChecked} kinds of hooks across ${coherence.documentsChecked} rule documents.`,
    ),
    lang,
  )}
  ${
    coherence.undocumentedSensors.length === 0
      ? t(
          L(
            "전부 문서에 이름이 나옵니다.",
            "Every one of them is named in a document.",
          ),
          lang,
        )
      : t(
          L(
            `설명 없이 막는 게이트 ${coherence.undocumentedSensors.length}종: ${coherence.undocumentedSensors.map((s) => escapeHtml(s)).join(" · ")}`,
            `${coherence.undocumentedSensors.length} kinds of gates block without explaining themselves: ${coherence.undocumentedSensors.map((s) => escapeHtml(s)).join(" · ")}`,
          ),
          lang,
        )
  }
  ${t(
    L(
      "검사 범위가 결론을 크게 바꿉니다. 같은 저장소에서 규칙 문서만 보면 미기재가 21종, 스킬까지 넣으면 4종이었습니다.",
      "The scope of the check changes the conclusion a lot. In the same repository, looking at rule documents alone left 21 kinds undocumented; adding skills left 4.",
    ),
    lang,
  )}</div>
</div>`;
}

/** 분모가 이보다 얇으면 차이를 표시하되 판단 근거로는 쓰지 않는다고 밝힌다. */
const TREND_THIN_DENOMINATOR = 100;

/**
 * 초기 절반과 최근 절반의 비교.
 *
 * 정의를 고치면 점수가 움직이는데 그건 측정이 바뀐 것이지 행동이 바뀐 게 아니다.
 * 같은 정의로 시기를 갈라야 그 둘이 분리된다.
 */
function renderTrend(rows: TrendRow[], lang: Lang): string {
  if (rows.length === 0) return "";
  const cell = (v: number | null) => (v === null ? "—" : v.toFixed(1));
  const arrow = (d: number | null) => {
    if (d === null) return "";
    if (Math.abs(d) < 2) return "flat";
    return d > 0 ? "up" : "down";
  };
  return `<div class="guide trend">
  <h2>${t(
    L(
      "성장 · 같은 정의로 초기 절반 대 최근 절반",
      "Growth · early half against recent half under one definition",
    ),
    lang,
  )}</h2>
  <table>
    <thead><tr><th>${t(L("항목", "Item"), lang)}</th><th>${t(
      L("초기", "Early"),
      lang,
    )}</th><th>${t(L("최근", "Recent"), lang)}</th><th>${t(
      L("변화", "Change"),
      lang,
    )}</th><th>${t(L("분모", "Denominator"), lang)}</th></tr></thead>
    <tbody>
    ${rows
      .map((r) => {
        const thin =
          r.parent !== null && r.denominator < TREND_THIN_DENOMINATOR;
        return `<tr class="${r.parent === null ? "statRow" : "compRow"}${thin ? " thin" : ""}">
        <td>${r.parent === null ? "" : "&nbsp;&nbsp;&nbsp;"}${escapeHtml(t(r.label, lang))}</td>
        <td class="n">${cell(r.early)}</td>
        <td class="n">${cell(r.late)}</td>
        <td class="n ${arrow(r.delta)}">${r.delta === null ? "—" : `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)}`}</td>
        <td class="n dim">${r.denominator.toLocaleString()}</td>
      </tr>`;
      })
      .join("")}
    </tbody>
  </table>
  <div class="crit">${t(
    L(
      `정의를 바꾸면 점수가 움직이지만 그건 측정이 바뀐 것입니다.
  같은 정의로 시기를 갈라야 행동 변화만 남습니다. 회색 줄은 분모가 ${TREND_THIN_DENOMINATOR}건 미만이라
  차이를 판단 근거로 쓰지 않습니다.`,
      `Changing a definition moves the score, but that is the measurement changing.
  Only splitting the periods under one definition leaves behavior change alone. Gray rows have a denominator under ${TREND_THIN_DENOMINATOR},
  so their differences are not used as grounds for judgment.`,
    ),
    lang,
  )}</div>
</div>`;
}

export function renderStatHtml(
  window: StatWindow,
  lang: Lang,
  options: {
    allTime?: boolean;
    trend?: TrendRow[];
    harness?: HarnessView;
  } = {},
): string {
  const gray = !window.judgeable;
  const scope =
    options.allTime === true
      ? t(L("전수 집계", "All-time"), lang)
      : t(
          L(`구간 #${window.periodIndex}`, `Period #${window.periodIndex}`),
          lang,
        );
  const coverage =
    window.coverage === null ? "—" : `${(window.coverage * 100).toFixed(0)}%`;

  const rankBasis =
    options.allTime === true
      ? t(
          L(
            "전수 집계라 등급을 절대 점수로 매겼습니다.",
            "This is an all-time roll-up, so the rank is given by absolute score.",
          ),
          lang,
        )
      : t(
          L(
            `등급은 내 이력 ${window.historyWindows}개 창에서의 위치입니다. 절대 기준이 아닙니다.`,
            `The rank is a position among ${window.historyWindows} windows of my own history. It is not an absolute standard.`,
          ),
          lang,
        );

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<title>Harness Scouter</title><style>${STYLE}</style></head>
<body><div class="wrap">
<div class="readout">
  <span class="brand">Harness Scouter</span>
  <span class="lv"><small>LEVEL</small>${window.level}</span>
  <span class="gradeChip" style="color:${gray ? "var(--dim)" : rankFill(window.overallRank)}">${window.overallRank}</span>
  <span class="scope">${scope} · ${t(
    L(`세션 ${window.sessionCount}개`, `${window.sessionCount} sessions`),
    lang,
  )}<br>
    ${window.startedAt.slice(0, 10)} ~ ${window.endedAt.slice(0, 10)}<br>
    ${t(L("계측 커버리지", "Instrumentation coverage"), lang)} <span class="num">${coverage}</span>${
      gray
        ? ` · <span class="flag">${t(L("판정 보류", "Judgment withheld"), lang)}</span>`
        : ""
    }</span>
</div>
<div class="chart">${renderRadarSvg(window.stats, lang, { grayedOut: gray })}</div>
<div class="stats">${window.stats.map((stat) => renderStat(stat, gray, lang)).join("\n")}</div>
${renderRubric(window.stats, lang)}
${
  gray
    ? ""
    : `<div class="guide">
  <h2>${t(L("성장 가이드", "Growth guide"), lang)}${
    options.allTime === true
      ? t(
          L(" · 병목 해소 이득 순", " · by gain from clearing the bottleneck"),
          lang,
        )
      : t(L(" · 개인 최고까지의 격차 순", " · by gap to personal best"), lang)
  }</h2>
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
        <span class="nm">${escapeHtml(t(a.label, lang))}</span>
        <span>${
          options.allTime === true
            ? num(a.score)
            : t(
                L(
                  `${num(a.score)} → 최고 ${num(a.best)}`,
                  `${num(a.score)} → best ${num(a.best)}`,
                ),
                lang,
              )
        }</span>
        <span class="gap">${t(
          L(
            `병목 해소 시 +${num(a.bottleneckGain)}`,
            `+${num(a.bottleneckGain)} once the bottleneck is cleared`,
          ),
          lang,
        )}</span>
        <span class="bn">${t(L("병목", "bottleneck"), lang)} ${a.bottleneck === null ? "—" : escapeHtml(t(a.bottleneck.label, lang))} ${
          a.bottleneck?.value == null
            ? ""
            : (a.bottleneck.value * 100).toFixed(0)
        }</span>
      </div>
      ${c === null ? "" : `<div class="crit">${escapeHtml(t(c.measures, lang))}</div>`}
      ${
        c === null
          ? ""
          : `<ul>${tList(c.actions, lang)
              .map((x) => `<li>${escapeHtml(x)}</li>`)
              .join("")}${tList(c.antipatterns, lang)
              .map((x) => `<li class="no">${escapeHtml(x)}</li>`)
              .join("")}</ul>`
      }
    </div>`;
    })
    .join("")}
</div>`
}
${
  gray
    ? `<div class="guide"><h2>${t(L("성장 가이드", "Growth guide"), lang)}</h2><div class="adv">${t(
        L(
          "계측 커버리지가 임계 아래라 이 구간의 값을 판정하지 않습니다. 커버리지가 회복된 구간에서 다시 보세요.",
          "Instrumentation coverage is below the floor, so the values for this period are not judged. Look again in a period where coverage has recovered.",
        ),
        lang,
      )}</div></div>`
    : ""
}
${renderHarness(options.harness, lang)}
${renderTrend(options.trend ?? [], lang)}
<div class="foot">
${t(
  L(
    `굵은 육각형은 100점 경계, 파선은 개인 최고, 채운 면은 지금입니다.
막대 안 옅은 띠는 통상 범위(p25~p75), 세로 눈금은 개인 최고입니다.`,
    `The bold hexagon is the 100-point boundary, the dashed line is the personal best, and the filled area is now.
The pale band inside a bar is the typical range (p25~p75), and the vertical tick is the personal best.`,
  ),
  lang,
)}<br>
${rankBasis} ${t(
    L(
      "직전 구간 대비 변화는 표시하지 않습니다. 구간 간 상관이 0 근처라 잡음이기 때문입니다.",
      "Change against the previous period is not shown. The correlation between periods sits near 0, so it is noise.",
    ),
    lang,
  )}<br>
${escapeHtml(t(validityState().caveat, lang))}
</div>
</div></body></html>`;
}
