#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  analyze,
  AXIS_LABELS,
  AXIS_ORDER,
  axisScore,
  diagnosePeriod,
  diagnoseExplorationTiming,
  buildStatWindow,
  mergePeriods,
  adviseAll,
  renderStatHtml,
  runGate,
  renderDiagnosisHtml,
  defaultDbPath,
  defaultTranscriptRoot,
  scan,
  ScouterDb,
  type AxisDelta,
  type PeriodReport,
} from "@harness-scouter/core";

const USAGE = `harness-scouter

  scouter scan [--root <path>] [--db <path>]    트랜스크립트를 증분 스캔한다
  scouter status [--db <path>] [--all]          능력치 스테이터스 창 (--all 이면 전수 집계)
  scouter report [--db <path>] [--project <s>]  최신 구간의 6축 원시값을 본다
  scouter periods [--db <path>]                 구간 목록을 본다
  scouter diag [--db <path>]                    최신 구간의 누수 지점과 근거 세션을 본다
  scouter guide [--db <path>] [--all]           능력치별 병목과 올리는 법
  scouter label <세션id> good|bad [--note <s>]   세션에 라벨을 붙인다
  scouter labels [--db <path>]                  붙인 라벨을 본다
  scouter gate [--db <path>]                    M0.5 재현성 게이트를 돌린다
  scouter json [--db <path>]                    확장이 읽을 JSON을 낸다
  scouter html [--db <path>] [--out <path>] [--all] [--diag]
                                                스테이터스 창을 HTML로 낸다 (--diag 면 누수 진단)
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

  if (command === "status") {
    const db = openDb(flags);
    const result = analyze(db);
    const closed = result.periods.filter((p) => !p.open);
    const current = flags.has("all") ? mergePeriods(closed) : closed.at(-1);
    if (current === undefined || current === null) {
      process.stdout.write(
        "닫힌 구간이 없습니다. scouter scan을 먼저 실행하세요.\n",
      );
      db.close();
      return;
    }
    const w = buildStatWindow(current, closed, {
      rankByAbsoluteScore: flags.has("all"),
    });
    const bar = (score: number | null): string => {
      if (score === null) return "·".repeat(24);
      const filled = Math.max(0, Math.min(24, Math.round((score / 100) * 24)));
      return "█".repeat(filled) + "░".repeat(24 - filled);
    };
    process.stdout.write(
      `\n  HARNESS SCOUTER  ${flags.has("all") ? "전수 집계" : `구간 #${w.periodIndex}`}       Lv.${String(w.level).padStart(3)}  ${w.overallRank}\n`,
    );
    process.stdout.write(
      `  ${w.startedAt.slice(0, 10)} ~ ${w.endedAt.slice(0, 10)} · 세션 ${w.sessionCount}개 · 이력 창 ${w.historyWindows}개` +
        (w.coverage === null
          ? ""
          : ` · 커버리지 ${(w.coverage * 100).toFixed(0)}%`) +
        (w.judgeable ? "" : "  판정 보류") +
        "\n",
    );
    process.stdout.write(`  ${"─".repeat(80)}\n`);
    for (const stat of w.stats) {
      const score =
        stat.score === null ? "  —" : stat.score.toFixed(0).padStart(3);
      const typical =
        stat.typicalLow === null || stat.typicalHigh === null
          ? "        "
          : `${stat.typicalLow.toFixed(0)}~${stat.typicalHigh.toFixed(0)}`.padStart(
              7,
            );
      const best =
        stat.best === null ? "  —" : stat.best.toFixed(0).padStart(3);
      process.stdout.write(
        `  ${stat.label.padEnd(8)} ${bar(stat.score)} ${score}  ${stat.rank}   통상 ${typical}  최고 ${best}\n`,
      );
      for (const c of stat.components) {
        const v =
          c.value === null ? "  —" : (c.value * 100).toFixed(0).padStart(3);
        process.stdout.write(
          `      ${c.label.padEnd(20)} ${v}   n=${String(c.denominator).padStart(5)}\n`,
        );
      }
    }
    process.stdout.write(`  ${"─".repeat(80)}\n`);
    process.stdout.write(
      `  종합 ${w.overall === null ? "—" : w.overall.toFixed(1)} · ${w.overallRank}\n` +
        (flags.has("all")
          ? "  전수 집계라 등급을 절대 점수로 매겼습니다. 구간별 등급은 --all 없이 보세요.\n"
          : `  등급은 내 이력 ${w.historyWindows}개 창 대비 위치입니다. 절대 기준이 아닙니다.\n`),
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

  if (command === "guide") {
    const db = openDb(flags);
    const result = analyze(db);
    const closed = result.periods.filter((p) => !p.open);
    const target = flags.has("all") ? mergePeriods(closed) : closed.at(-1);
    if (target === undefined || target === null) {
      process.stdout.write("닫힌 구간이 없습니다.\n");
      db.close();
      return;
    }
    const w = buildStatWindow(target, closed, {
      rankByAbsoluteScore: flags.has("all"),
    });
    process.stdout.write("\n  성장 가이드\n\n");
    const allTime = flags.has("all");
    process.stdout.write(
      allTime
        ? "  (전수 집계라 병목을 고쳤을 때 닫히는 몫으로 정렬합니다)\n\n"
        : "",
    );
    for (const advice of adviseAll(w.stats, { allTime })) {
      const gap = advice.gapToBest;
      const gain = advice.bottleneckGain;
      if (allTime ? (gain ?? 0) < 1 : gap === null || gap < 1) continue;
      process.stdout.write(
        allTime
          ? `  ${advice.label}  ${advice.score?.toFixed(0) ?? "—"}  (병목 해소 시 +${gain?.toFixed(0) ?? "—"})\n`
          : `  ${advice.label}  ${advice.score?.toFixed(0) ?? "—"} → 최고 ${advice.best?.toFixed(0) ?? "—"}  (+${gap?.toFixed(0) ?? "—"} 여지, 병목 해소 시 +${gain?.toFixed(0) ?? "—"})\n`,
      );
      const b = advice.bottleneck;
      const c = advice.criterion;
      if (b !== null) {
        process.stdout.write(
          `    병목: ${b.label} ${b.value === null ? "—" : (b.value * 100).toFixed(0)}점  n=${b.denominator.toLocaleString()}\n`,
        );
      }
      if (c !== null) {
        process.stdout.write(`    기준: ${c.measures}\n`);
        process.stdout.write(`    이유: ${c.whyItMatters}\n`);
        for (const a of c.actions) process.stdout.write(`      + ${a}\n`);
        for (const a of c.antipatterns) process.stdout.write(`      - ${a}\n`);
      }
      process.stdout.write("\n");
    }
    db.close();
    return;
  }

  if (command === "label") {
    const db = openDb(flags);
    const rest = process.argv.slice(3).filter((t) => !t.startsWith("--"));
    const prefix = rest[0];
    const label = rest[1];
    if (prefix === undefined || (label !== "good" && label !== "bad")) {
      process.stdout.write(
        "사용법: scouter label <세션id> good|bad [--note <메모>]\n",
      );
      db.close();
      return;
    }
    const sessionId = db.resolveSessionId(prefix);
    if (sessionId === null) {
      process.stdout.write(`세션을 특정하지 못했습니다: ${prefix}\n`);
      db.close();
      return;
    }
    db.setLabel(sessionId, label, flags.get("note") ?? null);
    process.stdout.write(`${sessionId.slice(0, 8)} → ${label}\n`);
    db.close();
    return;
  }

  if (command === "labels") {
    const db = openDb(flags);
    const rows = db.listLabels();
    const good = rows.filter((r) => r.label === "good").length;
    process.stdout.write(
      `라벨 ${rows.length}건 (good ${good} / bad ${rows.length - good})\n\n`,
    );
    for (const row of rows) {
      process.stdout.write(
        `  ${row.session_id.slice(0, 8)}  ${row.label.padEnd(4)}  ${row.labeled_at}  ${row.note ?? ""}\n`,
      );
    }
    if (rows.length < 30) {
      process.stdout.write(
        `\n  M1.5 타당성 게이트는 30건부터 의미가 있습니다. ${30 - rows.length}건 남았습니다.\n`,
      );
    }
    db.close();
    return;
  }

  if (command === "gate") {
    const db = openDb(flags);
    const result = analyze(db);
    const gate = runGate(result.sessions, result.forPeriods);
    process.stdout.write(
      `\n  M0.5 재현성 게이트 — 닫힌 구간 ${gate.periodCount}개\n\n`,
    );
    for (const axis of gate.axes) {
      process.stdout.write(
        `  ${axis.passed ? "통과" : "미달"}  ${AXIS_LABELS[axis.axis]}\n`,
      );
      for (const c of axis.checks) {
        process.stdout.write(
          `        ${c.passed ? "o" : "X"} ${c.name.padEnd(7)} ${c.value.padEnd(38)} ${c.criterion}\n`,
        );
      }
      process.stdout.write("\n");
    }
    const dependent = gate.correlations.filter((c) => !c.independent);
    process.stdout.write(
      dependent.length === 0
        ? "  축 독립성: 모든 쌍 |rho| <= 0.6\n"
        : `  축 독립성 위반 ${dependent.length}건:\n${dependent
            .map(
              (c) =>
                `        ${AXIS_LABELS[c.a]} ~ ${AXIS_LABELS[c.b]}  rho=${c.r.toFixed(3)}\n`,
            )
            .join("")}`,
    );
    const failed = gate.axes.filter((a) => !a.passed);
    process.stdout.write(
      `\n  결과: ${gate.axes.length - failed.length}/${gate.axes.length} 축 통과\n`,
    );
    db.close();
    return;
  }

  if (command === "diag") {
    const db = openDb(flags);
    const result = analyze(db);
    const report = result.latestClosed;
    if (report === null) {
      process.stdout.write("닫힌 구간이 없습니다.\n");
      db.close();
      return;
    }
    const merged = flags.has("all")
      ? mergePeriods(result.periods.filter((q) => !q.open))
      : null;
    const p = merged ?? report.period;
    process.stdout.write(
      `\n  구간 #${p.index}  ${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)}  세션 ${p.sessionIds.length}개\n\n`,
    );
    for (const d of diagnosePeriod(db, p)) {
      if (d.items.length === 0) continue;
      const axis = report.axes.find((a) => a.key === d.axis);
      const score =
        axis?.current == null ? "—" : `${(axis.current * 100).toFixed(0)}%`;
      process.stdout.write(
        `  ${AXIS_LABELS[d.axis]} (${score}) — ${d.headline}\n`,
      );
      for (const item of d.items) {
        process.stdout.write(
          `    ${String(item.count).padStart(4)}회  ${item.subject}\n`,
        );
        process.stdout.write(
          `          ${item.sessions.map((s) => s.slice(0, 8)).join(" ")}\n`,
        );
      }
      process.stdout.write("\n");
    }

    const timing = diagnoseExplorationTiming(db, p);
    process.stdout.write(
      "  탐색 적시성 — 조사 구간에서 인덱스를 언제 불렀나\n",
    );
    process.stdout.write(
      "    주체        구간   신호 전   소모 후   안 부름\n",
    );
    for (const [label, t] of [
      ["메인", timing.main],
      ["subagent", timing.subagent],
    ] as const) {
      if (t.episodes === 0) continue;
      const pct = (x: number) => `${((x * 100) / t.episodes).toFixed(0)}%`;
      process.stdout.write(
        `    ${label.padEnd(10)} ${String(t.episodes).padStart(5)}` +
          `${pct(t.before).padStart(9)}${pct(t.after).padStart(10)}${pct(t.never).padStart(9)}\n`,
      );
    }
    process.stdout.write(
      "    임계값은 임의값이라 절대 수치가 아니라 두 주체의 격차를 본다.\n\n",
    );
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
    const closedForHtml = result.periods.filter((p) => !p.open);
    const target = flags.has("diag")
      ? null
      : flags.has("all")
        ? mergePeriods(closedForHtml)
        : closedForHtml.at(-1);
    const html =
      target === null || target === undefined
        ? renderDiagnosisHtml(report, diagnosePeriod(db, report.period))
        : renderStatHtml(
            buildStatWindow(target, closedForHtml, {
              rankByAbsoluteScore: flags.has("all"),
            }),
            { allTime: flags.has("all") },
          );
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
    const diagnoses =
      result.latestClosed === null
        ? []
        : diagnosePeriod(db, result.latestClosed.period);
    process.stdout.write(
      JSON.stringify(
        {
          axisOrder: AXIS_ORDER,
          axisLabels: AXIS_LABELS,
          periodCount: result.periods.length,
          latestClosed: result.latestClosed,
          latest: result.latest,
          allTime: (() => {
            const closed = result.periods.filter((p) => !p.open);
            const merged = mergePeriods(closed);
            return merged === null
              ? null
              : buildStatWindow(merged, closed, { rankByAbsoluteScore: true });
          })(),
          diagnoses,
          leakCount: diagnoses.reduce(
            (sum, d) => sum + d.items.reduce((s, i) => s + i.count, 0),
            0,
          ),
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
