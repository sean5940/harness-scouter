#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import {
  analyze,
  AXIS_LABELS,
  AXIS_ORDER,
  axisScore,
  diagnosePeriod,
  diagnoseExplorationTiming,
  appendLabel,
  readLabels,
  defaultLabelPath,
  buildStatWindow,
  mergePeriods,
  compareHalves,
  marginToCut,
  COMPONENT_CRITERIA,
  OBJECTIVE_LABELS,
  CONTAMINATION_LABELS,
  scanHarness,
  fetchPrOutcomes,
  signalSpreads,
  checkCoherence,
  ruleDocumentPaths,
  summarizeHarness,
  STAGE_LABELS,
  adviseAll,
  renderStatHtml,
  runGate,
  runStratificationExperiment,
  sensitivityOf,
  verdictMark,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  renderDiagnosisHtml,
  defaultDbPath,
  defaultTranscriptRoot,
  PERIOD_MIN_SESSIONS,
  MIN_SESSIONS_FOR_SPLIT_HALF,
  scan,
  ScouterDb,
  guardBrokenPipe,
  L,
  resolveLang,
  t,
  tList,
  type AxisDelta,
  type Lang,
  type Localized,
  type PeriodReport,
} from "@harness-scouter/core";

import { parseArgs } from "./args.js";
import { VERSION } from "./version.js";

/**
 * 수치가 섞인 한 줄을 두 언어로 나란히 적고 하나를 고른다.
 *
 * 언어별 카탈로그 파일로 빼지 않고 쓰는 자리에 둔다. 같은 수치를 한 번만 적으므로
 * 한쪽 언어만 고쳐 숫자가 어긋나는 일이 생기지 않는다.
 */
function say(lang: Lang, ko: string, en: string): string {
  return t(L(ko, en), lang);
}

/**
 * 터미널에서 두 칸을 차지하는 코드포인트 구간.
 *
 * 한글·한자·가나는 한 글자가 두 칸이고 라틴은 한 칸이다. `String.length` 로 패딩하면
 * 한국어 화면에 맞춘 폭이 영어에서 절반으로 줄어 표가 통째로 밀린다.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

function charWidth(codePoint: number): number {
  for (const [low, high] of WIDE_RANGES) {
    if (codePoint >= low && codePoint <= high) return 2;
  }
  return 1;
}

/** 터미널에서 차지하는 칸 수. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** 표시폭 기준 오른쪽 채움. 폭을 넘는 문자열은 `padEnd` 처럼 그대로 둔다. */
function padEndW(text: string, width: number): string {
  const short = width - displayWidth(text);
  return short > 0 ? text + " ".repeat(short) : text;
}

/** 표시폭 기준 왼쪽 채움. */
function padStartW(text: string, width: number): string {
  const short = width - displayWidth(text);
  return short > 0 ? " ".repeat(short) + text : text;
}

/** 표시폭 기준 자르기. 두 칸짜리 글자가 경계에 걸리면 그 글자를 버린다. */
function sliceW(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out.trimEnd();
}

const USAGE: Localized = L(
  `harness-scouter

  scouter scan [--root <path>] [--db <path>]    트랜스크립트를 증분 스캔한다
       [--rebuild]                              사실 테이블을 비우고 처음부터 다시 읽는다
  scouter status [--db <path>] [--all]          능력치 스테이터스 창 (--all 이면 전수 집계)
  scouter report [--db <path>] [--project <s>]  최신 구간의 6축 원시값을 본다
  scouter periods [--db <path>]                 구간 목록을 본다
  scouter diag [--db <path>] [--all]            누수 지점·근거 세션과 탐색 적시성을 본다
  scouter guide [--db <path>] [--all]           능력치별 병목과 올리는 법
  scouter label <세션id> good|bad [--note <s>]   세션에 라벨을 붙인다
  scouter labels [--labels <path>]              붙인 라벨을 본다 (기본 ~/.harness-scouter/labels.jsonl)
  scouter harness [--root <path>]               하네스 구조(센서·가이드)를 스캔한다
  scouter outcomes [--root <path>]              PR 결과를 모아 신호 변별력을 본다
  scouter gate [--db <path>]                    M0.5 재현성 게이트를 돌린다
  scouter strata [--db <path>]                  split-half 를 작업 유형 층 안에서 다시 돌려 본다
  scouter json [--db <path>]                    확장이 읽을 JSON을 낸다
  scouter html [--db <path>] [--out <path>] [--all] [--diag] [--root <path>]
                                                스테이터스 창을 HTML로 낸다 (--diag 면 누수 진단)

  --lang <ko|en>                                화면 언어. 없으면 SCOUTER_LANG, 로케일, 영어 순으로 고른다
`,
  `harness-scouter

  scouter scan [--root <path>] [--db <path>]      Scan transcripts incrementally
       [--rebuild]                                Clear fact tables and read from scratch
  scouter status [--db <path>] [--all]            Stat window (--all aggregates every period)
  scouter report [--db <path>] [--project <s>]    Raw six-axis values for the latest period
  scouter periods [--db <path>]                   List the periods
  scouter diag [--db <path>] [--all]              Leak sites, evidence sessions, exploration timing
  scouter guide [--db <path>] [--all]             Bottleneck per stat and how to raise it
  scouter label <session-id> good|bad [--note <s>]  Attach a label to a session
  scouter labels [--labels <path>]                List the labels (default ~/.harness-scouter/labels.jsonl)
  scouter harness [--root <path>]                 Scan the harness structure (sensors, guides)
  scouter outcomes [--root <path>]                Collect PR results and look at signal spread
  scouter gate [--db <path>]                      Run the M0.5 reproducibility gate
  scouter strata [--db <path>]                    Re-run split-half inside work-type strata
  scouter json [--db <path>]                      Emit the JSON the extension reads
  scouter html [--db <path>] [--out <path>] [--all] [--diag] [--root <path>]
                                                  Emit the stat window as HTML (--diag for leak diagnosis)

  --lang <ko|en>                                  Display language. Falls back to SCOUTER_LANG, the locale, then English
`,
);

/**
 * 표 열 너비. 한글이 두 칸을 차지해 같은 내용이라도 언어마다 필요한 칸 수가 다르다.
 * 어느 쪽도 문자열을 자르지 않을 만큼 잡는다.
 */
const COLUMNS: Record<
  Lang,
  {
    axisLabel: number;
    statLabel: number;
    componentLabel: number;
    periodAxis: number;
    gateSupport: number;
    gateName: number;
    gateValue: number;
    signalName: number;
    signalDistinct: number;
    signalShare: number;
    timingSubject: number;
    scope: number;
  }
> = {
  ko: {
    axisLabel: 16,
    statLabel: 13,
    componentLabel: 20,
    periodAxis: 8,
    gateSupport: 11,
    gateName: 20,
    gateValue: 38,
    signalName: 12,
    signalDistinct: 4,
    signalShare: 11,
    timingSubject: 10,
    scope: 12,
  },
  en: {
    axisLabel: 26,
    statLabel: 18,
    componentLabel: 26,
    periodAxis: 10,
    gateSupport: 21,
    gateName: 26,
    gateValue: 44,
    signalName: 12,
    signalDistinct: 8,
    signalShare: 11,
    timingSubject: 10,
    scope: 14,
  },
};

/** 스탯 창에 함께 실을 하네스 구조 요약. 저장소를 못 읽으면 생략한다. */
function harnessViewOf(root: string) {
  try {
    const inventory = scanHarness(root, [
      join(homedir(), ".claude", "settings.json"),
    ]);
    if (inventory.sensors.length === 0) return undefined;
    return {
      sensorCount: inventory.sensors.length,
      autoCount: inventory.sensors.filter((s) => s.kind !== "skill").length,
      guideCount: inventory.guides.length,
      coverage: summarizeHarness(inventory),
      coherence: checkCoherence(inventory, ruleDocumentPaths(root)),
    };
  } catch {
    return undefined;
  }
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

function renderAxis(axis: AxisDelta, lang: Lang): string {
  const label = padEndW(
    t(AXIS_LABELS[axis.key], lang),
    COLUMNS[lang].axisLabel,
  );
  const flag = axis.unfilled
    ? say(lang, " ⚠분모부족", " ⚠ thin denominator")
    : "";
  return say(
    lang,
    `  ${label} ${bar(axis.current)} ${pct(axis.current)}  기준 ${pct(axis.baseline)}  ${signed(axis.delta)}  n=${String(axis.denominator).padStart(4)}${flag}`,
    `  ${label} ${bar(axis.current)} ${pct(axis.current)}  baseline ${pct(axis.baseline)}  ${signed(axis.delta)}  n=${String(axis.denominator).padStart(4)}${flag}`,
  );
}

function renderReport(report: PeriodReport, title: string, lang: Lang): string {
  const p = report.period;
  const lines: string[] = [];
  lines.push("");
  lines.push(
    say(
      lang,
      `  ${title}  #${p.index}  ${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)}  세션 ${p.sessionIds.length}개`,
      `  ${title}  #${p.index}  ${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)}  ${p.sessionIds.length} sessions`,
    ),
  );
  const cov = report.coverage;
  const covNote =
    cov === null
      ? ""
      : say(
          lang,
          `  계측 커버리지 ${(cov * 100).toFixed(1)}%`,
          `  instrumented coverage ${(cov * 100).toFixed(1)}%`,
        );
  const closeNote = p.open
    ? say(lang, "  (진행 중)", "  (open)")
    : p.closedByBudget
      ? ""
      : say(lang, "  (세션 상한으로 닫힘)", "  (closed by the session cap)");
  lines.push(`  ${"─".repeat(78)}`);
  for (const axis of report.axes) lines.push(renderAxis(axis, lang));
  lines.push(`  ${"─".repeat(78)}`);
  lines.push(`  ${covNote}${closeNote}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  let lang: Lang;
  try {
    lang = resolveLang(flags.get("lang"));
  } catch (error) {
    // 아직 언어를 못 정했으므로 사용법은 환경 기준 언어로 낸다.
    const fallback = resolveLang();
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${t(USAGE, fallback)}`,
    );
    process.exitCode = 1;
    return;
  }
  const usage = t(USAGE, lang);
  const noClosedPeriod = say(
    lang,
    "닫힌 구간이 없습니다.",
    "There is no closed period.",
  );
  const runScanFirst = say(
    lang,
    "닫힌 구간이 없습니다. scouter scan을 먼저 실행하세요.",
    "There is no closed period. Run scouter scan first.",
  );

  /**
   * 왜 구간이 없는지를 나눠 말한다.
   *
   * 스캔을 이미 돌렸는데도 "스캔하세요"가 나오면 같은 명령을 다시 치게 된다. 실제로 다른
   * 기계에서 그 일이 일어났다. 세션이 있는데 구간이 안 닫힌 것과 세션 자체가 없는 것은
   * 해야 할 일이 다르므로 화면에서 갈라야 한다.
   */
  const noPeriodReason = (
    sessionCount: number,
    openSessions: number,
  ): string => {
    if (sessionCount === 0) return runScanFirst;
    return say(
      lang,
      `닫힌 구간이 없습니다. 세션 ${sessionCount}개를 읽었지만 구간 하나를 닫으려면 세션이 ${PERIOD_MIN_SESSIONS}개 이상 필요하고 지금 ${openSessions}개입니다. 더 쓰신 뒤 다시 보세요.\n지금 볼 수 있는 것: scouter periods · scouter gate · scouter json`,
      `There is no closed period. ${sessionCount} sessions were read, but closing one needs at least ${PERIOD_MIN_SESSIONS} sessions and the open one has ${openSessions}. Come back after more sessions.\nWhat works now: scouter periods · scouter gate · scouter json`,
    );
  };

  // 명령 없이 플래그만 준 호출은 command 가 "help" 라, 버전을 먼저 봐야 `--version` 이
  // 사용법에 먹히지 않는다.
  if (command === "version" || flags.has("version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command === "help" || flags.has("help")) {
    process.stdout.write(usage);
    return;
  }

  if (command === "scan") {
    const db = openDb(flags);
    const root = flags.get("root") ?? defaultTranscriptRoot();
    // 추출·병합 규칙을 고친 뒤에는 증분으로 못 고친다. 이미 들어간 행이 낡은 규칙으로
    // 만든 값 그대로 남고, 커서가 앞서 있어 그 파일을 다시 읽지 않기 때문이다.
    if (flags.get("rebuild") === "true") {
      db.reset();
      process.stderr.write(
        say(
          lang,
          "재빌드: 사실 테이블을 비우고 처음부터 읽습니다\n",
          "Rebuild: cleared fact tables, reading from scratch\n",
        ),
      );
    }
    process.stderr.write(say(lang, `스캔: ${root}\n`, `Scanning: ${root}\n`));
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
        say(
          lang,
          `파일 ${stats.filesScanned}개 중 ${stats.filesChanged}개 갱신`,
          `${stats.filesChanged} of ${stats.filesScanned} files updated`,
        ),
        say(
          lang,
          `엔트리 ${stats.entriesParsed.toLocaleString()}건 파싱`,
          `${stats.entriesParsed.toLocaleString()} entries parsed`,
        ),
        stats.malformedLines > 0
          ? say(
              lang,
              `깨진 줄 ${stats.malformedLines}건 버림`,
              `${stats.malformedLines} broken lines dropped`,
            )
          : null,
        stats.fullReparses > 0
          ? say(
              lang,
              `전체 재파싱 ${stats.fullReparses}건`,
              `${stats.fullReparses} full reparses`,
            )
          : null,
        // 제외를 조용히 하면 코퍼스가 줄어든 이유를 나중에 못 찾는다.
        db.excludedSyntheticCount() > 0
          ? say(
              lang,
              `임시 워크스페이스 ${db.excludedSyntheticCount()}개 세션은 코퍼스에서 제외`,
              `${db.excludedSyntheticCount()} sessions in temp workspaces excluded from the corpus`,
            )
          : null,
        say(
          lang,
          `${(elapsedMs / 1000).toFixed(1)}초`,
          `${(elapsedMs / 1000).toFixed(1)}s`,
        ),
      ]
        .filter((s): s is string => s !== null)
        .join(" / ") + "\n",
    );
    const counts = db.counts();
    process.stdout.write(
      say(
        lang,
        `세션 ${counts["session"]} / 도구호출 ${counts["tool_call"]} / 결과 ${counts["tool_result"]}\n`,
        `sessions ${counts["session"]} / tool calls ${counts["tool_call"]} / results ${counts["tool_result"]}\n`,
      ),
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
      const open = result.periods.find((p) => p.open);
      process.stdout.write(
        `${noPeriodReason(result.sessions.length, open?.sessionIds.length ?? 0)}\n`,
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
    const scope = flags.has("all")
      ? say(lang, "전수 집계", "all-time")
      : say(lang, `구간 #${w.periodIndex}`, `period #${w.periodIndex}`);
    process.stdout.write(
      `\n  HARNESS SCOUTER  ${padEndW(scope, COLUMNS[lang].scope)}   Lv.${String(w.level).padStart(3)}  ${w.overallRank}\n`,
    );
    process.stdout.write(
      say(
        lang,
        `  ${w.startedAt.slice(0, 10)} ~ ${w.endedAt.slice(0, 10)} · 세션 ${w.sessionCount}개 · 이력 창 ${w.historyWindows}개`,
        `  ${w.startedAt.slice(0, 10)} ~ ${w.endedAt.slice(0, 10)} · ${w.sessionCount} sessions · ${w.historyWindows} history windows`,
      ) +
        (w.coverage === null
          ? ""
          : say(
              lang,
              ` · 커버리지 ${(w.coverage * 100).toFixed(0)}%`,
              ` · coverage ${(w.coverage * 100).toFixed(0)}%`,
            )) +
        (w.judgeable ? "" : say(lang, "  판정 보류", "  judgment withheld")) +
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
      const label = padEndW(t(stat.label, lang), COLUMNS[lang].statLabel);
      process.stdout.write(
        say(
          lang,
          `  ${label} ${bar(stat.score)} ${score}  ${stat.rank}   통상 ${typical}  최고 ${best}\n`,
          `  ${label} ${bar(stat.score)} ${score}  ${stat.rank}   typical ${typical}  best ${best}\n`,
        ),
      );
      // 구성요소 중 일부만으로 낸 점수면 그 사실을 적는다. 안 적으면 셋 중 하나로 낸
      // 점수를 셋 다 잰 점수로 읽는다. 인덱스 검색만 반복한 세션이 탐색력 100 을 받는
      // 것이 이 표시가 없을 때 벌어지는 일이다.
      if (stat.score !== null && stat.scoredCount < stat.scorableCount) {
        process.stdout.write(
          `      ${say(lang, `구성요소 ${stat.scorableCount}개 중 ${stat.scoredCount}개로 냈습니다`, `scored from ${stat.scoredCount} of ${stat.scorableCount} components`)}\n`,
        );
      }
      for (const c of stat.components) {
        const v =
          c.value === null ? "  —" : (c.value * 100).toFixed(0).padStart(3);
        // 점수에 안 들어가는 구성요소는 그렇다고 적는다. 안 적으면 읽는 사람이 스탯을
        // 구성요소 전부의 평균으로 읽어 왜 그 숫자가 나왔는지 못 맞춘다.
        const note =
          c.displayOnly === true ? `  ${say(lang, "(표시)", "(display)")}` : "";
        process.stdout.write(
          `      ${padEndW(t(c.label, lang), COLUMNS[lang].componentLabel)} ${v}   n=${String(c.denominator).padStart(5)}${note}\n`,
        );
      }
    }
    process.stdout.write(`  ${"─".repeat(80)}\n`);
    const margin = flags.has("all") ? marginToCut(w.overall) : null;
    process.stdout.write(
      say(
        lang,
        `  종합 ${w.overall === null ? "—" : w.overall.toFixed(1)} · ${w.overallRank}`,
        `  Overall ${w.overall === null ? "—" : w.overall.toFixed(1)} · ${w.overallRank}`,
      ) +
        (margin === null
          ? ""
          : say(
              lang,
              `  (가장 가까운 등급 컷까지 ${margin.toFixed(1)}p)`,
              `  (${margin.toFixed(1)}p to the nearest grade cut)`,
            )) +
        "\n" +
        (flags.has("all")
          ? say(
              lang,
              "  전수 집계라 등급을 절대 점수로 매겼습니다. 구간별 등급은 --all 없이 보세요.\n",
              "  All-time aggregate, so grades come from absolute scores. Drop --all for per-period grades.\n",
            )
          : say(
              lang,
              `  등급은 내 이력 ${w.historyWindows}개 창 대비 위치입니다. 절대 기준이 아닙니다.\n`,
              `  Grades are a position against my own ${w.historyWindows} history windows. Not an absolute standard.\n`,
            )),
    );
    db.close();
    return;
  }

  if (command === "report") {
    const db = openDb(flags);
    const project = flags.get("project");
    const result = analyze(db, project !== undefined ? { project } : {});
    if (result.latestClosed === null) {
      const open = result.periods.find((p) => p.open);
      process.stdout.write(
        `${noPeriodReason(result.sessions.length, open?.sessionIds.length ?? 0)}\n`,
      );
      db.close();
      return;
    }
    process.stdout.write(
      renderReport(
        result.latestClosed,
        say(lang, "최신 구간", "Latest period"),
        lang,
      ),
    );
    process.stdout.write("\n");
    if (result.latest !== null && result.latest.period.open) {
      process.stdout.write(
        renderReport(result.latest, say(lang, "진행 중", "Open"), lang),
      );
      process.stdout.write("\n");
    }
    db.close();
    return;
  }

  if (command === "periods") {
    const db = openDb(flags);
    const result = analyze(db);
    process.stdout.write(
      say(
        lang,
        `구간 ${result.periods.length}개 (세션 ${result.sessions.length}개)\n\n`,
        `${result.periods.length} periods (${result.sessions.length} sessions)\n\n`,
      ),
    );
    const axisWidth = COLUMNS[lang].periodAxis;
    process.stdout.write(
      "  " +
        padStartW("#", 2) +
        " " +
        padStartW(say(lang, "세션", "n"), 4) +
        "  " +
        padEndW(say(lang, "기간", "Period"), 18) +
        AXIS_ORDER.map((k) =>
          padStartW(sliceW(t(AXIS_LABELS[k], lang), axisWidth), axisWidth),
        ).join(" ") +
        "\n",
    );
    for (const p of result.periods) {
      const scores = AXIS_ORDER.map((k) => {
        const score = axisScore(k, p.axes[k]);
        return padStartW(
          score === null ? "    —" : `${(score * 100).toFixed(0).padStart(4)}%`,
          axisWidth,
        );
      }).join(" ");
      const note = p.open
        ? say(lang, " 진행중", " open")
        : p.closedByBudget
          ? ""
          : say(lang, " 상한", " cap");
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
      process.stdout.write(`${noClosedPeriod}\n`);
      db.close();
      return;
    }
    const w = buildStatWindow(target, closed, {
      rankByAbsoluteScore: flags.has("all"),
    });
    process.stdout.write(
      say(lang, "\n  성장 가이드\n\n", "\n  Growth guide\n\n"),
    );
    const allTime = flags.has("all");
    process.stdout.write(
      allTime
        ? say(
            lang,
            "  (전수 집계라 병목을 고쳤을 때 닫히는 몫으로 정렬합니다)\n\n",
            "  (All-time aggregate, so this is sorted by how much fixing the bottleneck closes)\n\n",
          )
        : "",
    );
    for (const advice of adviseAll(w.stats, { allTime })) {
      const gap = advice.gapToBest;
      const gain = advice.bottleneckGain;
      if (allTime ? (gain ?? 0) < 1 : gap === null || gap < 1) continue;
      const label = t(advice.label, lang);
      process.stdout.write(
        allTime
          ? say(
              lang,
              `  ${label}  ${advice.score?.toFixed(0) ?? "—"}  (병목 해소 시 +${gain?.toFixed(0) ?? "—"})\n`,
              `  ${label}  ${advice.score?.toFixed(0) ?? "—"}  (+${gain?.toFixed(0) ?? "—"} once the bottleneck is fixed)\n`,
            )
          : say(
              lang,
              `  ${label}  ${advice.score?.toFixed(0) ?? "—"} → 최고 ${advice.best?.toFixed(0) ?? "—"}  (+${gap?.toFixed(0) ?? "—"} 여지, 병목 해소 시 +${gain?.toFixed(0) ?? "—"})\n`,
              `  ${label}  ${advice.score?.toFixed(0) ?? "—"} → best ${advice.best?.toFixed(0) ?? "—"}  (+${gap?.toFixed(0) ?? "—"} headroom, +${gain?.toFixed(0) ?? "—"} once the bottleneck is fixed)\n`,
            ),
      );
      const b = advice.bottleneck;
      const c = advice.criterion;
      if (b !== null) {
        process.stdout.write(
          say(
            lang,
            `    병목: ${t(b.label, lang)} ${b.value === null ? "—" : (b.value * 100).toFixed(0)}점  n=${b.denominator.toLocaleString()}\n`,
            `    Bottleneck: ${t(b.label, lang)} ${b.value === null ? "—" : (b.value * 100).toFixed(0)}  n=${b.denominator.toLocaleString()}\n`,
          ),
        );
      }
      if (c !== null) {
        process.stdout.write(
          say(
            lang,
            `    기준: ${t(c.measures, lang)}\n`,
            `    Measures: ${t(c.measures, lang)}\n`,
          ),
        );
        process.stdout.write(
          say(
            lang,
            `    이유: ${t(c.whyItMatters, lang)}\n`,
            `    Why: ${t(c.whyItMatters, lang)}\n`,
          ),
        );
        for (const a of tList(c.actions, lang)) {
          process.stdout.write(`      + ${a}\n`);
        }
        for (const a of tList(c.antipatterns, lang)) {
          process.stdout.write(`      - ${a}\n`);
        }
      }
      process.stdout.write("\n");
    }
    db.close();
    return;
  }

  if (command === "label") {
    const db = openDb(flags);
    const rest = process.argv.slice(3).filter((x) => !x.startsWith("--"));
    const prefix = rest[0];
    const label = rest[1];
    if (prefix === undefined || (label !== "good" && label !== "bad")) {
      process.stdout.write(
        say(
          lang,
          "사용법: scouter label <세션id> good|bad [--note <메모>]\n",
          "Usage: scouter label <session-id> good|bad [--note <memo>]\n",
        ),
      );
      db.close();
      return;
    }
    const sessionId = db.resolveSessionId(prefix);
    if (sessionId === null) {
      process.stdout.write(
        say(
          lang,
          `세션을 특정하지 못했습니다: ${prefix}\n`,
          `Could not pin down a session: ${prefix}\n`,
        ),
      );
      db.close();
      return;
    }
    const labelPath = flags.get("labels") ?? defaultLabelPath();
    appendLabel(labelPath, {
      sessionId,
      label,
      note: flags.get("note") ?? null,
      labeledAt: new Date().toISOString(),
    });
    process.stdout.write(`${sessionId.slice(0, 8)} → ${label}\n`);
    db.close();
    return;
  }

  if (command === "labels") {
    const labelPath = flags.get("labels") ?? defaultLabelPath();
    const rows = readLabels(labelPath);
    const good = rows.filter((r) => r.label === "good").length;
    process.stdout.write(
      say(
        lang,
        `라벨 ${rows.length}건 (good ${good} / bad ${rows.length - good})  ${labelPath}\n\n`,
        `${rows.length} labels (good ${good} / bad ${rows.length - good})  ${labelPath}\n\n`,
      ),
    );
    for (const row of rows) {
      process.stdout.write(
        `  ${row.sessionId.slice(0, 8)}  ${row.label.padEnd(4)}  ${row.labeledAt}  ${row.note ?? ""}\n`,
      );
    }
    if (rows.length < 30) {
      process.stdout.write(
        say(
          lang,
          `\n  M1.5 타당성 게이트는 30건부터 의미가 있습니다. ${30 - rows.length}건 남았습니다.\n`,
          `\n  The M1.5 validity gate only means something from 30 on. ${30 - rows.length} to go.\n`,
        ),
      );
    }
    return;
  }

  if (command === "harness") {
    const root = flags.get("root") ?? process.cwd();
    const extra = [join(homedir(), ".claude", "settings.json")];
    const inventory = scanHarness(root, extra);
    const sum = summarizeHarness(inventory);
    const auto = inventory.sensors.filter((x) => x.kind !== "skill").length;
    process.stdout.write(
      say(
        lang,
        `\n  하네스 구조  ${root}\n\n`,
        `\n  Harness structure  ${root}\n\n`,
      ),
    );
    process.stdout.write(
      say(
        lang,
        `  센서 ${sum.sensorCount}개 (자동 ${auto} · 수동 ${sum.sensorCount - auto}) · 가이드 ${sum.guideCount}개\n\n`,
        `  ${sum.sensorCount} sensors (automatic ${auto} · manual ${sum.sensorCount - auto}) · ${sum.guideCount} guides\n\n`,
      ),
    );
    process.stdout.write(
      say(
        lang,
        `  방향   feedforward ${sum.byDirection.feedforward}  ·  feedback ${sum.byDirection.feedback}\n`,
        `  Direction   feedforward ${sum.byDirection.feedforward}  ·  feedback ${sum.byDirection.feedback}\n`,
      ),
    );
    process.stdout.write(
      say(
        lang,
        `  실행   computational ${sum.byExecution.computational}  ·  inferential ${sum.byExecution.inferential}\n`,
        `  Execution   computational ${sum.byExecution.computational}  ·  inferential ${sum.byExecution.inferential}\n`,
      ),
    );
    // STAGE_LABELS 는 Localized 라 언어를 골라야 한다. 그대로 넣으면 단계 이름이
    // 전부 [object Object] 로 나와서 분포를 읽을 수 없다.
    const stages = (Object.keys(sum.byStage) as Array<keyof typeof sum.byStage>)
      .map((k) => `${STAGE_LABELS[k][lang]} ${sum.byStage[k]}`)
      .join("  ·  ");
    process.stdout.write(
      say(lang, `  단계   ${stages}\n`, `  Stage   ${stages}\n`),
    );
    if (sum.emptyStages.length > 0) {
      const empty = sum.emptyStages
        .map((k) => STAGE_LABELS[k][lang])
        .join(", ");
      process.stdout.write(
        say(
          lang,
          `\n  센서 없는 단계: ${empty}\n`,
          `\n  Stages with no sensor: ${empty}\n`,
        ),
      );
    }
    const coherence = checkCoherence(inventory, ruleDocumentPaths(root));
    process.stdout.write(
      say(
        lang,
        `\n  가이드·센서 동기화   규칙 문서 ${coherence.documentsChecked}개에서 훅 ${coherence.sensorsChecked}종 확인\n`,
        `\n  Guide/sensor sync   ${coherence.sensorsChecked} hook kinds checked across ${coherence.documentsChecked} rule documents\n`,
      ),
    );
    if (coherence.undocumentedSensors.length === 0) {
      process.stdout.write(
        say(
          lang,
          "    전부 문서에 이름이 나옵니다.\n",
          "    Every one of them is named in a document.\n",
        ),
      );
    } else {
      process.stdout.write(
        say(
          lang,
          `    설명 없이 막는 게이트 ${coherence.undocumentedSensors.length}종: ${coherence.undocumentedSensors.join(" · ")}\n`,
          `    ${coherence.undocumentedSensors.length} gate kinds block without an explanation: ${coherence.undocumentedSensors.join(" · ")}\n`,
        ),
      );
    }
    for (const note of inventory.notScanned) {
      process.stdout.write(
        say(lang, `  못 봄: ${note[lang]}\n`, `  Not read: ${note[lang]}\n`),
      );
    }
    process.stdout.write(
      say(
        lang,
        "\n  축 이름은 Martin Fowler 의 harness engineering 에서 가져왔습니다.\n" +
          "  센서 수는 행동 지표의 분모입니다. 차단 0건이 센서가 좋아서인지 없어서인지는\n" +
          "  이 목록을 봐야 갈립니다.\n",
        "\n  The axis names come from Martin Fowler's harness engineering.\n" +
          "  The sensor count is the denominator of the behavioral metrics. Zero blocks could mean\n" +
          "  good sensors or no sensors, and only this list tells the two apart.\n",
      ),
    );
    return;
  }

  if (command === "outcomes") {
    const root = flags.get("root") ?? process.cwd();
    process.stderr.write(
      say(
        lang,
        "PR 목록을 가져오는 중입니다. 시간이 걸립니다.\n",
        "Fetching the PR list. This takes a while.\n",
      ),
    );
    let outcomes;
    try {
      outcomes = fetchPrOutcomes(root, 800);
    } catch {
      process.stdout.write(
        say(
          lang,
          "PR 을 가져오지 못했습니다. gh 인증과 저장소를 확인하세요.\n",
          "Could not fetch the PRs. Check gh auth and the repository.\n",
        ),
      );
      return;
    }
    const list = [...outcomes.values()];
    const db = openDb(flags);
    const linked = new Set(
      db
        .prOutcomeRefs()
        .map((r) => Number(r))
        .filter((n) => Number.isFinite(n)),
    );
    db.close();
    const mine = list.filter((o) => linked.has(o.number));
    process.stdout.write(
      say(
        lang,
        `\n  PR 결과  ${root}\n\n  저장소 ${list.length}건 · 세션에 연결된 것 ${mine.length}건\n\n`,
        `\n  PR results  ${root}\n\n  ${list.length} in the repository · ${mine.length} linked to a session\n\n`,
      ),
    );
    const cols = COLUMNS[lang];
    process.stdout.write(
      "  " +
        padEndW(say(lang, "신호", "Signal"), cols.signalName) +
        " " +
        padStartW(say(lang, "갈래", "Branches"), cols.signalDistinct) +
        "  " +
        padStartW(say(lang, "최빈값 비중", "Top share"), cols.signalShare) +
        "   " +
        say(lang, "요약", "Summary") +
        "\n",
    );
    for (const s of signalSpreads(mine.length > 0 ? mine : list)) {
      process.stdout.write(
        `  ${padEndW(s.name, cols.signalName)} ${padStartW(String(s.distinct), cols.signalDistinct)}  ${padStartW(`${(s.topShare * 100).toFixed(0)}%`, cols.signalShare)}   ${s.summary}\n`,
      );
    }
    process.stdout.write(
      say(
        lang,
        "\n  최빈값 비중이 1 에 가까우면 사실상 상수라 상관을 볼 수 없습니다.\n" +
          "  변별력 없는 신호로 상관이 안 나온 것을 지표가 틀렸다고 읽으면 안 됩니다.\n",
        "\n  A top share near 1 means the signal is effectively a constant, so no correlation can be read.\n" +
          "  A signal with no spread failing to correlate does not mean the metric is wrong.\n",
      ),
    );
    return;
  }

  if (command === "gate") {
    const db = openDb(flags);
    const result = analyze(db);
    const gate = runGate(result.sessions, result.forPeriods, lang);
    const cols = COLUMNS[lang];
    process.stdout.write(
      say(
        lang,
        `\n  M0.5 재현성 게이트 — 닫힌 구간 ${gate.periodCount}개\n\n`,
        `\n  M0.5 reproducibility gate — ${gate.periodCount} closed periods\n\n`,
      ),
    );
    for (const axis of gate.axes) {
      const support = axis.supportsPerPeriod
        ? say(lang, "전수·구간별", "all-time + per-period")
        : axis.supportsAllTime
          ? say(lang, "전수 집계만", "all-time only")
          : say(lang, "미달", "not met");
      process.stdout.write(
        `  ${padEndW(support, cols.gateSupport)}  ${t(AXIS_LABELS[axis.axis], lang)}\n`,
      );
      for (const c of axis.checks) {
        process.stdout.write(
          `        ${verdictMark(c.verdict)} ${padEndW(t(c.name, lang), cols.gateName)} ${padEndW(c.value, cols.gateValue)} ${t(c.criterion, lang)}\n`,
        );
      }
      process.stdout.write("\n");
    }
    const dependent = gate.correlations.filter(
      (c) => c.independence === "fail",
    );
    // 계산 불가를 독립 쪽에 접으면 "모든 쌍이 독립"이라는 문장이 재보지도 못한 쌍까지
    // 덮는다. 따로 세서 따로 적는다.
    const uncomputable = gate.correlations.filter(
      (c) => c.independence === "not-computable",
    );
    process.stdout.write(
      dependent.length === 0
        ? say(
            lang,
            "  축 독립성: 판정된 쌍은 모두 |rho| <= 0.6\n",
            "  Axis independence: every judged pair |rho| <= 0.6\n",
          )
        : say(
            lang,
            `  축 독립성 위반 ${dependent.length}건:\n`,
            `  ${dependent.length} axis-independence violations:\n`,
          ) +
            dependent
              .map(
                (c) =>
                  `        ${t(AXIS_LABELS[c.a], lang)} ~ ${t(AXIS_LABELS[c.b], lang)}  rho=${c.r.toFixed(3)}\n`,
              )
              .join(""),
    );
    if (uncomputable.length > 0) {
      process.stdout.write(
        say(
          lang,
          `  축 독립성 계산 불가 ${uncomputable.length}쌍 — 한쪽이 상수이거나 점수 있는 구간이 3개 미만입니다. 독립으로 세지 않습니다:\n`,
          `  ${uncomputable.length} pairs not computable — one side is constant, or there are fewer than 3 scored periods. Not counted as independent:\n`,
        ) +
          uncomputable
            .map(
              (c) =>
                `        ${t(AXIS_LABELS[c.a], lang)} ~ ${t(AXIS_LABELS[c.b], lang)}\n`,
            )
            .join(""),
      );
    }
    const allTime = gate.axes.filter((a) => a.supportsAllTime).length;
    const perPeriod = gate.axes.filter((a) => a.supportsPerPeriod).length;
    process.stdout.write(
      say(
        lang,
        `\n  전수 집계 화면 ${allTime}/${gate.axes.length} 축 · 구간별 화면 ${perPeriod}/${gate.axes.length} 축\n`,
        `\n  All-time view ${allTime}/${gate.axes.length} axes · per-period view ${perPeriod}/${gate.axes.length} axes\n`,
      ),
    );
    if (perPeriod < allTime) {
      process.stdout.write(
        say(
          lang,
          "  구간별에서만 죽는 축은 구간 안에서 점수가 재현되지 않는다는 뜻입니다.\n" +
            "  전수 집계는 모든 구간을 합쳐 하나의 점수를 내므로 그 조건이 필요 없습니다.\n",
          "  An axis that dies only in the per-period view does not reproduce its score inside a period.\n" +
            "  The all-time view merges every period into one score, so it does not need that.\n",
        ),
      );
    }
    db.close();
    return;
  }

  if (command === "strata") {
    const db = openDb(flags);
    const result = analyze(db);
    const experiment = runStratificationExperiment(
      result.sessions,
      result.forPeriods,
      result.workload,
    );
    db.close();

    const base = experiment.variants[0];
    if (base === undefined) {
      process.stdout.write(`${noClosedPeriod}\n`);
      return;
    }

    const cols = COLUMNS[lang];
    process.stdout.write(
      say(
        lang,
        `\n  층화 실험 — split-half 가 쓸 수 있는 구간 ${experiment.usablePeriods}개 · 세션 ${experiment.sessionCount}개\n\n`,
        `\n  Stratification experiment — ${experiment.usablePeriods} periods usable by split-half · ${experiment.sessionCount} sessions\n\n`,
      ),
    );

    if (experiment.usablePeriods < 3) {
      // 구간이 모자라면 층화 전도 못 낸다. 표를 빈칸으로 그리면 "층화가 효과 없다"로 읽힌다.
      process.stdout.write(
        say(
          lang,
          `  세션 ${MIN_SESSIONS_FOR_SPLIT_HALF}개 이상인 구간이 3개는 있어야 순열 split-half 를 냅니다. 더 쓰신 뒤 다시 보세요.\n`,
          `  The permuted split-half needs at least 3 periods with ${MIN_SESSIONS_FOR_SPLIT_HALF} or more sessions each. Come back after more sessions.\n`,
        ),
      );
      return;
    }

    process.stdout.write(
      say(
        lang,
        `  층 분포 (기본 임계 새 파일 비중 ${base.thresholds.createShare.toFixed(2)} · 검증 하한 ${base.thresholds.verifyMin})\n`,
        `  Strata (default thresholds: create share ${base.thresholds.createShare.toFixed(2)} · verify floor ${base.thresholds.verifyMin})\n`,
      ),
    );
    process.stdout.write(
      "    " +
        WORK_TYPES.map(
          (k) => `${t(WORK_TYPE_LABELS[k], lang)} ${base.sizes[k]}`,
        ).join("  ·  ") +
        // 유형을 못 매긴 세션도 자기들끼리 한 층이 된다. 안 적으면 층 수의 합이
        // 세션 수와 안 맞는 이유를 읽는 사람이 알 길이 없다.
        (experiment.unknownSessions > 0
          ? say(
              lang,
              `  ·  유형 모름 ${experiment.unknownSessions}`,
              `  ·  unknown ${experiment.unknownSessions}`,
            )
          : "") +
        "\n\n",
    );

    if (base.occupiedStrata < 2) {
      process.stdout.write(
        say(
          lang,
          "  세션이 한 층에 다 들어갔습니다. 층화가 가르는 것이 없어 아래 표는 층화 전과 같습니다.\n\n",
          "  Every session landed in one stratum. Stratification splits nothing, so the table below equals the unstratified run.\n\n",
        ),
      );
    }

    process.stdout.write(
      "  " +
        padEndW(say(lang, "축", "Axis"), cols.axisLabel) +
        padStartW(say(lang, "층화 전", "Plain"), 10) +
        padStartW(say(lang, "층화 후", "Stratified"), 12) +
        padStartW(say(lang, "이동", "Shift"), 9) +
        padStartW(say(lang, "위약 최대", "Placebo max"), 13) +
        padStartW(say(lang, "판정", "Verdict"), 10) +
        "\n",
    );
    const num = (v: number | null | undefined): string =>
      v === null || v === undefined ? "—" : v.toFixed(3);
    const signed = (v: number | null | undefined): string =>
      v === null || v === undefined
        ? "—"
        : `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
    // 가운데 뽑기가 아니라 가장 많이 오른 뽑기를 적는다. 표에서 "이동 > 위약 최대"가
    // 그대로 읽히고, 넘었다는 판단이 운 좋은 뽑기 하나에 걸리지 않는다.
    const placeboByAxis = new Map(
      experiment.placebo.map((p) => [p.axis, p.deltaRange?.max ?? null]),
    );
    for (const row of base.axes) {
      process.stdout.write(
        "  " +
          padEndW(t(AXIS_LABELS[row.axis], lang), cols.axisLabel) +
          padStartW(num(row.plain?.median), 10) +
          padStartW(num(row.stratified?.median), 12) +
          padStartW(signed(row.delta), 9) +
          padStartW(signed(placeboByAxis.get(row.axis)), 13) +
          padStartW(
            `${verdictMark(row.verdictBefore)} → ${verdictMark(row.verdictAfter)}`,
            10,
          ) +
          "\n",
      );
    }

    process.stdout.write(
      say(
        lang,
        `\n  임계 민감도 — 변형 ${experiment.variants.length}개\n`,
        `\n  Threshold sensitivity — ${experiment.variants.length} variants\n`,
      ),
    );
    process.stdout.write(
      "  " +
        padEndW(say(lang, "축", "Axis"), cols.axisLabel) +
        padStartW(say(lang, "이동 범위", "Shift range"), 20) +
        padStartW(say(lang, "부호 일정", "Sign stable"), 14) +
        padStartW(say(lang, "판정 뒤집힘", "Flipped"), 14) +
        "\n",
    );
    const sensitivity = sensitivityOf(experiment);
    for (const s of sensitivity) {
      const range =
        s.min === null || s.max === null
          ? "—"
          : `${s.min >= 0 ? "+" : ""}${s.min.toFixed(3)} ~ ${s.max >= 0 ? "+" : ""}${s.max.toFixed(3)}`;
      process.stdout.write(
        "  " +
          padEndW(t(AXIS_LABELS[s.axis], lang), cols.axisLabel) +
          padStartW(range, 20) +
          // 못 낸 축에 X 를 찍으면 "부호가 흔들렸다"로 읽힌다. 안 흔들린 것이 아니라
          // 재보지 못한 것이라, 게이트의 계산 불가와 같은 자리에 둔다.
          padStartW(s.min === null ? "—" : s.signStable ? "o" : "X", 14) +
          padStartW(`${s.flipped}/${experiment.variants.length}`, 14) +
          "\n",
      );
    }

    // 무엇을 읽어야 하는지 적는다. 이 표는 점수가 아니라 한 번의 대조라, 어느 방향으로
    // 나오면 무엇을 해야 하는지가 표 안에 안 들어 있다.
    const raised = sensitivity.filter(
      (s) => s.signStable && (s.min ?? 0) > 0,
    ).length;
    // 위약을 못 넘은 축은 셈에서 뺀다. 층화는 작업 구성을 맞추는 동시에 분할 자체를
    // 제약하는데, 제약만으로 오른 것이라면 라벨이 아무 뜻이 없어도 같은 이동이 나온다.
    // 견주는 상대는 가장 많이 오른 위약 뽑기다. 가운데와 견주면 뽑기 하나가 낮게
    // 나온 덕에 "넘었다"가 되는 축이 생긴다.
    const beyondPlacebo = sensitivity.filter((s) => {
      if (!s.signStable || (s.min ?? 0) <= 0) return false;
      const real = base.axes.find((a) => a.axis === s.axis)?.delta;
      const fake = placeboByAxis.get(s.axis);
      if (real === null || real === undefined) return false;
      if (fake === null || fake === undefined) return false;
      return real > fake;
    }).length;
    process.stdout.write(
      say(
        lang,
        `\n  부호가 일정하게 올라간 축 ${raised}/${sensitivity.length} · 그중 잡음 바닥을 넘은 축 ${beyondPlacebo}\n\n` +
          "  위약은 층 크기는 그대로 두고 누가 어느 층이냐만 흩은 대조입니다. 뜻 없는 라벨로\n" +
          "  잰 이동이라, 이 값이 곧 이동의 잡음 바닥입니다. 얼마나 움직여야 움직인 것인지는\n" +
          "  이동 하나만 봐서는 알 수 없고 이 값이 있어야 정해집니다. 표의 위약 값은 뽑기\n" +
          "  세 번 중 가장 많이 오른 것이라, 이동이 그 값을 넘어야 넘은 것으로 셉니다.\n\n" +
          "  올라갔고 바닥을 넘었다면 구간 점수를 흔든 것은 축이 아니라 반쪽마다 달라지는\n" +
          "  작업 구성입니다. 고정 태스크 셋(프로브)으로 작업 구성을 상수로 만들면 같은 축이\n" +
          "  살아납니다.\n" +
          "  안 올라갔다면 원인은 작업 구성이 아니므로, 프로브를 만들어도 이 축은 안 살아납니다.\n" +
          "  올랐는데 바닥을 못 넘었다면 그 크기의 이동은 라벨이 아무 뜻이 없어도 나옵니다.\n" +
          "  읽지 마세요.\n" +
          "  부호가 변형마다 갈려도 읽지 마세요. 층화가 아니라 임계가 만든 값입니다.\n\n" +
          "  위약이 지우지 못하는 것이 하나 남습니다. 작업 유형이 분모 크기의 대리 변수라면\n" +
          "  층화는 분모를 맞춘 것이고, 이동은 작업 유형이 아니라 분모가 만든 것일 수 있습니다.\n" +
          "  프로브는 어느 쪽이든 둘 다 상수로 만들지만, 무엇을 고정해야 하는지는 달라집니다.\n\n" +
          "  이 실험은 게이트 판정을 바꾸지 않습니다. 분류기가 아직 검증되지 않은\n" +
          "  임의 임계 위에 서 있어서, 이것으로 통과선을 옮기면 통과할 이유를 찾아\n" +
          "  기준을 고친 것이 됩니다.\n",
        `\n  Axes that rose with a stable sign: ${raised}/${sensitivity.length} · of those, above the noise floor: ${beyondPlacebo}\n\n` +
          "  The placebo keeps the stratum sizes and shuffles only which session sits in which\n" +
          "  stratum. It is a shift measured with labels that mean nothing, which makes it the noise\n" +
          "  floor for the shift. How far something has to move before it has moved is not readable\n" +
          "  from the shift alone; this is the number that settles it. The placebo column is the\n" +
          "  largest of three draws, so a shift must clear that to count.\n\n" +
          "  If an axis rose and cleared the floor, what moved the period scores was not the axis\n" +
          "  but the work mix that differs between halves. Pinning the work mix with a fixed task set\n" +
          "  (a probe) revives those axes. If it did not rise, the work mix is not the cause and a\n" +
          "  probe will not revive it. If it rose but stayed under the floor, a shift that size also\n" +
          "  appears when the labels mean nothing — do not read it. If the sign flips across\n" +
          "  variants, do not read it either; that came from the threshold.\n\n" +
          "  One thing the placebo cannot rule out: if work type is a proxy for denominator size,\n" +
          "  stratifying balanced the denominator, and the shift may be the denominator's rather\n" +
          "  than the work type's. A probe pins both either way, but what you pin differs.\n\n" +
          "  This experiment does not change the gate verdict. The classifier still rests on\n" +
          "  arbitrary, unvalidated thresholds, and moving the pass line with it would be\n" +
          "  editing the standard to find a reason to pass.\n",
      ),
    );
    return;
  }

  if (command === "diag") {
    const db = openDb(flags);
    const result = analyze(db);
    const report = result.latestClosed;
    if (report === null) {
      process.stdout.write(`${noClosedPeriod}\n`);
      db.close();
      return;
    }
    const merged = flags.has("all")
      ? mergePeriods(result.periods.filter((q) => !q.open))
      : null;
    const p = merged ?? report.period;
    process.stdout.write(
      say(
        lang,
        `\n  구간 #${p.index}  ${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)}  세션 ${p.sessionIds.length}개\n\n`,
        `\n  Period #${p.index}  ${p.startedAt.slice(0, 10)} ~ ${p.endedAt.slice(0, 10)}  ${p.sessionIds.length} sessions\n\n`,
      ),
    );
    for (const d of diagnosePeriod(db, p, lang)) {
      if (d.items.length === 0) continue;
      const axis = report.axes.find((a) => a.key === d.axis);
      const score =
        axis?.current == null ? "—" : `${(axis.current * 100).toFixed(0)}%`;
      process.stdout.write(
        `  ${t(AXIS_LABELS[d.axis], lang)} (${score}) · ${t(d.headline, lang)}\n`,
      );
      for (const item of d.items) {
        process.stdout.write(
          say(
            lang,
            `    ${String(item.count).padStart(4)}회  ${item.subject}\n`,
            `    ${String(item.count).padStart(4)}x  ${item.subject}\n`,
          ),
        );
        process.stdout.write(
          `          ${item.sessions.map((s) => s.slice(0, 8)).join(" ")}\n`,
        );
      }
      process.stdout.write("\n");
    }

    const timing = diagnoseExplorationTiming(db, p);
    const subjectWidth = COLUMNS[lang].timingSubject;
    process.stdout.write(
      say(
        lang,
        "  탐색 적시성 — 조사 구간에서 인덱스를 언제 불렀나\n",
        "  Exploration timing — when the index was called during an investigation\n",
      ),
    );
    process.stdout.write(
      "    " +
        padEndW(say(lang, "주체", "Actor"), subjectWidth) +
        padStartW(say(lang, "구간", "Spans"), 6) +
        padStartW(say(lang, "신호 전", "Before"), 9) +
        padStartW(say(lang, "소모 후", "After"), 9) +
        padStartW(say(lang, "안 부름", "Never"), 9) +
        "\n",
    );
    for (const [label, row] of [
      [say(lang, "메인", "main"), timing.main],
      ["subagent", timing.subagent],
    ] as const) {
      if (row.episodes === 0) continue;
      const share = (x: number) => `${((x * 100) / row.episodes).toFixed(0)}%`;
      process.stdout.write(
        "    " +
          padEndW(label, subjectWidth) +
          padStartW(String(row.episodes), 6) +
          padStartW(share(row.before), 9) +
          padStartW(share(row.after), 9) +
          padStartW(share(row.never), 9) +
          "\n",
      );
    }
    process.stdout.write(
      say(
        lang,
        "    임계값은 임의값이라 절대 수치가 아니라 두 주체의 격차를 본다.\n\n",
        "    The thresholds are arbitrary, so read the gap between the two actors, not the absolute numbers.\n\n",
      ),
    );
    db.close();
    return;
  }

  if (command === "html") {
    const db = openDb(flags);
    const result = analyze(db);
    const report = result.latestClosed;
    if (report === null) {
      process.stdout.write(`${noClosedPeriod}\n`);
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
        ? renderDiagnosisHtml(
            report,
            diagnosePeriod(db, report.period, lang),
            lang,
          )
        : renderStatHtml(
            buildStatWindow(target, closedForHtml, {
              rankByAbsoluteScore: flags.has("all"),
            }),
            lang,
            {
              allTime: flags.has("all"),
              trend: compareHalves(closedForHtml),
              harness: harnessViewOf(flags.get("root") ?? process.cwd()),
            },
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
        : diagnosePeriod(db, result.latestClosed.period, lang);
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

  process.stderr.write(
    say(
      lang,
      `알 수 없는 명령: ${command}\n\n${usage}`,
      `Unknown command: ${command}\n\n${usage}`,
    ),
  );
  process.exitCode = 1;
}

// 첫 줄을 쓰기 전에 걸어야 한다. head 는 세 줄 만에 파이프를 닫는다.
guardBrokenPipe(process.stdout, () => process.exit(0));

main().catch((error: unknown) => {
  // 여기서는 플래그를 못 읽으므로 환경 기준 언어로 낸다.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    say(resolveLang(), `실패: ${message}\n`, `Failed: ${message}\n`),
  );
  process.exitCode = 1;
});
