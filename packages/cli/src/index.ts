#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  analyze,
  AXIS_LABELS,
  AXIS_ORDER,
  axisScore,
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
