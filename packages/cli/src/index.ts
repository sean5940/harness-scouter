#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  analyze,
  AXIS_LABELS,
  AXIS_ORDER,
  axisScore,
  renderRadarSvg,
  defaultDbPath,
  defaultTranscriptRoot,
  scan,
  ScouterDb,
  type AxisDelta,
  type PeriodReport,
} from "@harness-scouter/core";

const USAGE = `harness-scouter

  scouter scan [--root <path>] [--db <path>]    트랜스크립트를 증분 스캔한다
  scouter report [--db <path>] [--project <s>]  최신 구간의 6축과 변화를 본다
  scouter periods [--db <path>]                 구간 목록을 본다
  scouter json [--db <path>]                    확장이 읽을 JSON을 낸다
  scouter html [--db <path>] [--out <path>]     육각형 리포트를 HTML로 낸다 (--out - 이면 stdout)
`;

function parseArgs(argv: string[]): {
  command: string;
  flags: Map<string, string>;
} {
  const command = argv[0] ?? "help";
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const next = argv[i + 1];
    flags.set(
      token.slice(2),
      next !== undefined && !next.startsWith("--") ? next : "true",
    );
    if (next !== undefined && !next.startsWith("--")) i += 1;
  }
  return { command, flags };
}

function openDb(flags: Map<string, string>): ScouterDb {
  const path = flags.get("db") ?? defaultDbPath();
  mkdirSync(dirname(path), { recursive: true });
  return new ScouterDb(path);
}

function pct(value: number | null): string {
  return value === null ? "  —  " : `${(value * 100).toFixed(1).padStart(5)}%`;
}

function signed(value: number | null): string {
  if (value === null) return "   —   ";
  const points = value * 100;
  const sign = points > 0 ? "+" : points < 0 ? "" : " ";
  return `${sign}${points.toFixed(1).padStart(5)}p`;
}

function bar(value: number | null): string {
  if (value === null) return "·".repeat(20);
  const filled = Math.max(0, Math.min(20, Math.round(value * 20)));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function renderAxis(axis: AxisDelta): string {
  const label = AXIS_LABELS[axis.key].padEnd(9, " ");
  const flag = axis.unfilled ? " ⚠분모부족" : "";
  return `  ${label} ${bar(axis.current)} ${pct(axis.current)}  기준 ${pct(axis.baseline)}  ${signed(axis.delta)}  n=${String(axis.denominator).padStart(4)}${flag}`;
}

function renderReport(report: PeriodReport, title: string): string {
  const p = report.period;
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  ${title}  #${p.index}  ${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)}  세션 ${p.sessionIds.length}개`,
  );
  const cov = report.coverage;
  const covNote =
    cov === null ? "" : `  계측 커버리지 ${(cov * 100).toFixed(1)}%`;
  const closeNote = p.open
    ? "  (진행 중)"
    : p.closedByBudget
      ? ""
      : "  (세션 상한으로 닫힘)";
  lines.push(`  ${"─".repeat(78)}`);
  for (const axis of report.axes) lines.push(renderAxis(axis));
  lines.push(`  ${"─".repeat(78)}`);
  lines.push(`  ${covNote}${closeNote}`);
  return lines.join("\n");
}

/** Webview에 그대로 옮길 수 있도록 외부 리소스 없이 한 파일로 만든다 (설계 7절 CSP 제약). */
function renderHtml(report: PeriodReport): string {
  const p = report.period;
  const cov = report.coverage;
  const grayedOut = cov !== null && cov < 0.5;
  const svg = renderRadarSvg(report.axes, { grayedOut });

  const rows = report.axes
    .map((a) => {
      const value =
        a.current === null ? "—" : `${(a.current * 100).toFixed(1)}%`;
      const base =
        a.baseline === null ? "—" : `${(a.baseline * 100).toFixed(1)}%`;
      const delta =
        a.delta === null
          ? "—"
          : `<span class="${a.delta >= 0 ? "up" : "down"}">${a.delta >= 0 ? "+" : ""}${(a.delta * 100).toFixed(1)}p</span>`;
      return `<tr><td>${AXIS_LABELS[a.key]}${a.unfilled ? ' <span class="warn">분모부족</span>' : ""}</td><td class="num">${value}</td><td class="num dim">${base}</td><td class="num">${delta}</td><td class="num dim">${a.denominator}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>Harness Scouter</title>
<style>
:root{--hs-bg:#fff;--hs-text:#1b1f2a;--hs-text-dim:#6b7280;--hs-grid:#c7cbe0;--hs-grid-muted:#e3e5ec;
--hs-baseline:#2c3e91;--hs-current:#a8905c;--hs-muted:#b6bac6;--hs-up:#1a7f4b;--hs-down:#b3352c;--hs-line:#e6e8ef}
@media (prefers-color-scheme:dark){:root{--hs-bg:#14161c;--hs-text:#e7e9f0;--hs-text-dim:#9aa0ae;
--hs-grid:#3a4058;--hs-grid-muted:#282c38;--hs-baseline:#7b90e8;--hs-current:#d9bd7d;--hs-muted:#565b6a;
--hs-up:#54c68a;--hs-down:#e8776c;--hs-line:#272a35}}
body{margin:0;padding:28px;background:var(--hs-bg);color:var(--hs-text);
font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Apple SD Gothic Neo',sans-serif}
.wrap{max-width:860px;margin:0 auto}
h1{font-size:19px;margin:0 0 4px}
.meta{color:var(--hs-text-dim);font-size:13px;margin-bottom:18px}
.chart{max-width:560px;margin:0 auto}
table{width:100%;border-collapse:collapse;margin-top:22px;font-size:14px}
th,td{padding:9px 10px;border-bottom:1px solid var(--hs-line);text-align:left}
th{color:var(--hs-text-dim);font-weight:600;font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:var(--hs-text-dim)}
.up{color:var(--hs-up)}.down{color:var(--hs-down)}
.warn{color:var(--hs-down);font-size:11px}
.note{margin-top:14px;font-size:12px;color:var(--hs-text-dim);line-height:1.6}
</style></head><body><div class="wrap">
<h1>구간 #${p.index}</h1>
<div class="meta">${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)} · 세션 ${p.sessionIds.length}개 · 계측 커버리지 ${
    cov === null ? "—" : `${(cov * 100).toFixed(1)}%`
  }${grayedOut ? " · 커버리지 미달로 판정 보류" : ""}</div>
<div class="chart">${svg}</div>
<table><thead><tr><th>축</th><th class="num">현재</th><th class="num">기준</th><th class="num">변화</th><th class="num">분모</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="note">굵은 육각형은 눈금 상한, 파선은 직전 3구간 중앙값(기준), 채운 면은 이번 구간이다.
파선 밖으로 나간 축이 기준보다 좋아진 축이다.
마주보는 축은 서로 상충한다 — 읽기 범위↔읽기 왕복, 검증 신선도↔검증 공회전.</div>
</div></body></html>`;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.has("help")) {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "scan") {
    const db = openDb(flags);
    const root = flags.get("root") ?? defaultTranscriptRoot();
    process.stderr.write(`스캔: ${root}\n`);
    const started = process.hrtime.bigint();
    const stats = await scan(db, {
      root,
      onProgress: (done, total) => {
        if (done % 100 === 0 || done === total) {
          process.stderr.write(`\r  ${done}/${total}`);
        }
      },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    process.stderr.write("\n");
    process.stdout.write(
      [
        `파일 ${stats.filesScanned}개 중 ${stats.filesChanged}개 갱신`,
        `엔트리 ${stats.entriesParsed.toLocaleString()}건 파싱`,
        stats.malformedLines > 0
          ? `깨진 줄 ${stats.malformedLines}건 버림`
          : null,
        stats.fullReparses > 0 ? `전체 재파싱 ${stats.fullReparses}건` : null,
        `${(elapsedMs / 1000).toFixed(1)}초`,
      ]
        .filter((s): s is string => s !== null)
        .join(" / ") + "\n",
    );
    const counts = db.counts();
    process.stdout.write(
      `세션 ${counts["session"]} / 도구호출 ${counts["tool_call"]} / 결과 ${counts["tool_result"]}\n`,
    );
    db.close();
    return;
  }

  if (command === "report") {
    const db = openDb(flags);
    const project = flags.get("project");
    const result = analyze(db, project !== undefined ? { project } : {});
    if (result.latestClosed === null) {
      process.stdout.write(
        "닫힌 구간이 없습니다. scouter scan을 먼저 실행하세요.\n",
      );
      db.close();
      return;
    }
    process.stdout.write(renderReport(result.latestClosed, "최신 구간"));
    process.stdout.write("\n");
    if (result.latest !== null && result.latest.period.open) {
      process.stdout.write(renderReport(result.latest, "진행 중"));
      process.stdout.write("\n");
    }
    db.close();
    return;
  }

  if (command === "periods") {
    const db = openDb(flags);
    const result = analyze(db);
    process.stdout.write(
      `구간 ${result.periods.length}개 (세션 ${result.sessions.length}개)\n\n`,
    );
    process.stdout.write(
      "  #  세션  기간                      " +
        AXIS_ORDER.map((k) => AXIS_LABELS[k].slice(0, 4).padStart(5)).join(
          " ",
        ) +
        "\n",
    );
    for (const p of result.periods) {
      const scores = AXIS_ORDER.map((k) => {
        const score = axisScore(k, p.axes[k]);
        return score === null
          ? "    —"
          : `${(score * 100).toFixed(0).padStart(4)}%`;
      }).join(" ");
      const note = p.open ? " 진행중" : p.closedByBudget ? "" : " 상한";
      process.stdout.write(
        `  ${String(p.index).padStart(2)} ${String(p.sessionIds.length).padStart(4)}  ${p.startedAt.slice(0, 10)}~${p.endedAt.slice(5, 10)}  ${scores}${note}\n`,
      );
    }
    db.close();
    return;
  }

  if (command === "html") {
    const db = openDb(flags);
    const result = analyze(db);
    const report = result.latestClosed;
    if (report === null) {
      process.stdout.write("닫힌 구간이 없습니다.\n");
      db.close();
      return;
    }
    const out = flags.get("out") ?? "/tmp/harness-scouter.html";
    const html = renderHtml(report);
    if (out === "-") {
      // 확장이 파이프로 받아 Webview에 그대로 넣는다.
      process.stdout.write(html);
    } else {
      writeFileSync(out, html, "utf8");
      process.stdout.write(`${out}\n`);
    }
    db.close();
    return;
  }

  if (command === "json") {
    const db = openDb(flags);
    const result = analyze(db);
    process.stdout.write(
      JSON.stringify(
        {
          axisOrder: AXIS_ORDER,
          axisLabels: AXIS_LABELS,
          periodCount: result.periods.length,
          latestClosed: result.latestClosed,
          latest: result.latest,
        },
        null,
        2,
      ) + "\n",
    );
    db.close();
    return;
  }

  process.stderr.write(`알 수 없는 명령: ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `실패: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
