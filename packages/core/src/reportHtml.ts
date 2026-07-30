import { AXIS_LABELS } from "./definitions.js";
import type { AxisDiagnosis } from "./diagnose.js";
import type { PeriodReport } from "./periods.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 긴 경로는 끝쪽이 정보가 많다. 앞을 줄인다. */
function shortenPath(subject: string): string {
  if (subject.length <= 72) return subject;
  return `...${subject.slice(-69)}`;
}

const STYLE = `
:root{--hs-bg:#fff;--hs-text:#1b1f2a;--hs-dim:#6b7280;--hs-line:#e6e8ef;
--hs-accent:#2c3e91;--hs-warn:#b3352c;--hs-chip:#f2f4f9;--hs-code:#f6f7fb}
@media (prefers-color-scheme:dark){:root{--hs-bg:#14161c;--hs-text:#e7e9f0;--hs-dim:#9aa0ae;
--hs-line:#272a35;--hs-accent:#8fa2f0;--hs-warn:#e8776c;--hs-chip:#1e212a;--hs-code:#1a1d25}}
body{margin:0;padding:26px 22px 60px;background:var(--hs-bg);color:var(--hs-text);
font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Apple SD Gothic Neo',sans-serif;
font-size:14px;line-height:1.55}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:18px;margin:0 0 3px}
.meta{color:var(--hs-dim);font-size:12.5px;margin-bottom:6px}
.hint{color:var(--hs-dim);font-size:12px;margin-bottom:22px;padding:9px 12px;
background:var(--hs-chip);border-radius:6px}
.axis{margin-bottom:26px}
.axis h2{font-size:14.5px;margin:0 0 2px;display:flex;align-items:baseline;gap:8px}
.axis .head{color:var(--hs-dim);font-size:12.5px;font-weight:400}
.axis .n{color:var(--hs-dim);font-size:12px;font-weight:400;margin-left:auto}
ul{list-style:none;margin:8px 0 0;padding:0}
li{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--hs-line);align-items:baseline}
li:last-child{border-bottom:none}
.count{flex:0 0 52px;text-align:right;font-variant-numeric:tabular-nums;color:var(--hs-warn);font-weight:600}
.subject{flex:1;min-width:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.sessions{flex:0 0 auto;color:var(--hs-dim);font-size:11.5px;font-family:ui-monospace,Menlo,monospace}
.empty{color:var(--hs-dim);font-size:12.5px;padding:6px 0}
.foot{margin-top:34px;padding-top:16px;border-top:1px solid var(--hs-line);
color:var(--hs-dim);font-size:12px}
.foot code{background:var(--hs-code);padding:1px 5px;border-radius:3px}
`;

/**
 * 뷰 B 진단 리포트.
 *
 * 점수를 그리지 않는다. M0.5 게이트에서 축의 구간 간 안정성이 없다는 것이 확인됐고
 * (설계 8.1), 그 상태에서 비율을 띄우면 잡음을 개선으로 읽게 된다. 대신 건수와
 * 근거 세션만 낸다. 축이 흔들려도 "이 파일을 8번 다시 읽었다"는 사실은 그대로다.
 *
 * Webview에 그대로 넣을 수 있도록 외부 리소스 없이 한 파일로 만든다 (설계 7절 CSP 제약).
 */
export function renderDiagnosisHtml(
  report: PeriodReport,
  diagnoses: AxisDiagnosis[],
): string {
  const p = report.period;
  const cov = report.coverage;
  const totalLeaks = diagnoses.reduce(
    (sum, d) => sum + d.items.reduce((s, i) => s + i.count, 0),
    0,
  );

  const sections = diagnoses
    .map((d) => {
      const axisTotal = d.items.reduce((s, i) => s + i.count, 0);
      const body =
        d.items.length === 0
          ? `<div class="empty">잡힌 것 없음</div>`
          : `<ul>${d.items
              .map(
                (item) =>
                  `<li><span class="count">${item.count}회</span>` +
                  `<span class="subject">${escapeHtml(shortenPath(item.subject))}</span>` +
                  `<span class="sessions">${item.sessions
                    .map((s) => escapeHtml(s.slice(0, 8)))
                    .join(" ")}</span></li>`,
              )
              .join("")}</ul>`;
      return `<div class="axis"><h2>${AXIS_LABELS[d.axis]}<span class="head">${escapeHtml(
        d.headline,
      )}</span><span class="n">${axisTotal}건</span></h2>${body}</div>`;
    })
    .join("\n");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>Harness Scouter 누수 진단</title><style>${STYLE}</style></head>
<body><div class="wrap">
<h1>누수 진단 · 구간 #${p.index}</h1>
<div class="meta">${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)} · 세션 ${
    p.sessionIds.length
  }개 · 계측 커버리지 ${cov === null ? "—" : `${(cov * 100).toFixed(1)}%`} · 합계 ${totalLeaks}건</div>
<div class="hint">점수를 그리지 않습니다. 축의 구간 간 안정성이 확보되지 않아
비율을 띄우면 잡음을 개선으로 읽게 됩니다. 건수와 근거 세션만 냅니다.</div>
${sections}
<div class="foot">근거 세션은 앞 8자만 표시합니다. 전체는 <code>scouter diag</code>로 확인하세요.</div>
</div></body></html>`;
}
