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
  renderDiagnosisHtml,
  defaultDbPath,
  defaultTranscriptRoot,
  scan,
  ScouterDb,
  L,
  resolveLang,
  t,
  tList,
  type AxisDelta,
  type Lang,
  type Localized,
  type PeriodReport,
} from "@harness-scouter/core";

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
  scouter json [--db <path>]                    확장이 읽을 JSON을 낸다
  scouter html [--db <path>] [--out <path>] [--all] [--diag] [--root <path>]
                                                스테이터스 창을 HTML로 낸다 (--diag 면 누수 진단)

  --lang <ko|en>                                화면 언어. 없으면 SCOUTER_LANG, 로케일, 영어 순으로 고른다
`,
  `harness-scouter

  scouter scan [--root <path>] [--db <path>]      Scan transcripts incrementally
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

function parseArgs(argv: string[]): {
  command: string;
  flags: Map<string, string>;
} {
  // 첫 토큰이 플래그면 명령이 없는 호출이다. `scouter --lang klingon` 을 명령 이름으로
  // 읽으면 언어 오류 대신 "알 수 없는 명령"이 나와 무엇이 틀렸는지 알 수 없다.
  const first = argv[0];
  const named = first !== undefined && !first.startsWith("--");
  const command = named ? first : "help";
  const flags = new Map<string, string>();
  for (let i = named ? 1 : 0; i < argv.length; i += 1) {
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
      process.stdout.write(`${runScanFirst}\n`);
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
      process.stdout.write(`${runScanFirst}\n`);
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
    const stages = (Object.keys(sum.byStage) as Array<keyof typeof sum.byStage>)
      .map((k) => `${STAGE_LABELS[k]} ${sum.byStage[k]}`)
      .join("  ·  ");
    process.stdout.write(
      say(lang, `  단계   ${stages}\n`, `  Stage   ${stages}\n`),
    );
    if (sum.emptyStages.length > 0) {
      const empty = sum.emptyStages.map((k) => STAGE_LABELS[k]).join(", ");
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
        say(lang, `  못 봄: ${note}\n`, `  Not read: ${note}\n`),
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
          `        ${c.passed ? "o" : "X"} ${padEndW(t(c.name, lang), cols.gateName)} ${padEndW(c.value, cols.gateValue)} ${t(c.criterion, lang)}\n`,
        );
      }
      process.stdout.write("\n");
    }
    const dependent = gate.correlations.filter((c) => !c.independent);
    process.stdout.write(
      dependent.length === 0
        ? say(
            lang,
            "  축 독립성: 모든 쌍 |rho| <= 0.6\n",
            "  Axis independence: every pair |rho| <= 0.6\n",
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
        `  ${t(AXIS_LABELS[d.axis], lang)} (${score}) — ${d.headline}\n`,
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

main().catch((error: unknown) => {
  // 여기서는 플래그를 못 읽으므로 환경 기준 언어로 낸다.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    say(resolveLang(), `실패: ${message}\n`, `Failed: ${message}\n`),
  );
  process.exitCode = 1;
});
