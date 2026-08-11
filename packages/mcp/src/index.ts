#!/usr/bin/env node
/**
 * 에이전트가 자기 하네스 품질을 조회하는 MCP 서버.
 *
 * 세션 중에 "내 탐색력이 53이고 병목이 파일 찾기 규율"을 읽고 행동을 바꿀 수 있다.
 * 사람이 사후에 보는 대시보드와 달리 행동 시점에 닿는다는 것이 이 서버의 이유다.
 *
 * 조작 유인에 대해. 자기 점수를 보면서 점수를 올리려 하는 순간 조작 경로가 열린다.
 * 그래서 두 가지를 지킨다. 하나, 읽기 전용이다. 라벨 쓰기나 DB 수정은 노출하지 않는다.
 * 둘, guide 는 안티패턴을 함께 낸다. 점수만 오르고 품질은 안 오르는 처방을 같은 응답에
 * 실어야 "가장 싼 개선책이 대개 조작"이라는 것이 행동 시점에 보인다.
 *
 * SDK 를 쓰지 않고 stdio JSON-RPC 를 직접 다룬다. 이 저장소의 런타임 의존성 0개 원칙을
 * 지키기 위해서다. 프로토콜에서 쓰는 것은 initialize·tools/list·tools/call 셋뿐이다.
 */
import { createInterface } from "node:readline";
import {
  analyze,
  adviseAll,
  buildStatWindow,
  compareHalves,
  checkCoherence,
  defaultDbPath,
  diagnosePeriod,
  guardBrokenPipe,
  mergePeriods,
  resolveLang,
  ruleDocumentPaths,
  runGate,
  scanHarness,
  segmentIntoPeriods,
  summarizeHarness,
  t,
  tList,
  ScouterDb,
  type Lang,
} from "@harness-scouter/core";

const PROTOCOL_VERSION = "2024-11-05";

interface Request {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const lang: Lang = resolveLang(process.env.SCOUTER_LANG);
const dbPath = process.env.SCOUTER_DB ?? defaultDbPath();

/**
 * 창을 한 번 만들어 돌려쓴다.
 *
 * 도구 호출마다 890MB 코퍼스를 다시 읽으면 에이전트가 세션 중에 쓸 수 없다. 대신
 * 서버가 뜬 뒤 새로 쌓인 세션은 안 보인다. 재시작이 곧 갱신이라는 뜻이고, 행동 시점
 * 조회라는 목적에는 그 편이 맞다. 조회할 때마다 점수가 움직이면 판단 근거가 안 된다.
 */
let cached: ReturnType<typeof buildWindow> | null = null;

function buildWindow() {
  const db = new ScouterDb(dbPath);
  try {
    const result = analyze(db);
    const periods = segmentIntoPeriods(result.forPeriods);
    const closed = periods.filter((p) => !p.open);
    const merged = mergePeriods(closed);
    const window =
      merged === null
        ? null
        : buildStatWindow(merged, closed, { rankByAbsoluteScore: true });
    return { result, periods, closed, window };
  } finally {
    db.close();
  }
}

function state() {
  cached ??= buildWindow();
  return cached;
}

const TOOLS = [
  {
    name: "scouter_status",
    description:
      "Current harness stats (six axes) with per-component scores and the bottleneck. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all-time", "latest"],
          description:
            "all-time aggregates every period; latest is the newest period only",
        },
      },
    },
  },
  {
    name: "scouter_guide",
    description:
      "How to raise the lowest stats: what is counted, why it matters, concrete actions, and the antipatterns that raise the score without raising quality. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scouter_diag",
    description:
      "Where efficiency leaks: whole-file reads, commits without checks, file access through bash, and exploration timing. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scouter_harness",
    description:
      "Harness structure: sensor and guide inventory, Fowler axes, and which gates are undocumented. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repository root to scan" },
      },
      required: ["root"],
    },
  },
  {
    name: "scouter_gate",
    description:
      "Reproducibility gate: which axes actually support which screen, and why the rest do not. Read this before trusting any number above. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
];

function statusText(scope: string): string {
  const s = state();
  if (scope === "latest") {
    const latest = s.closed.at(-1);
    if (latest === undefined) return "구간이 없습니다 / no closed period yet";
    const w = buildStatWindow(latest, s.closed);
    return renderWindow(w);
  }
  if (s.window === null) return "구간이 없습니다 / no closed period yet";
  return renderWindow(s.window);
}

function renderWindow(
  w: NonNullable<ReturnType<typeof state>["window"]>,
): string {
  const lines = [
    `Lv. ${w.level} ${w.overallRank} · overall ${w.overall?.toFixed(1) ?? "—"}`,
    `sessions ${w.sessionCount} · history windows ${w.historyWindows}`,
    "",
  ];
  for (const stat of w.stats) {
    lines.push(
      `${t(stat.label, lang)}  ${stat.score?.toFixed(0) ?? "—"}  ${stat.rank}` +
        (stat.best === null ? "" : `  (best ${stat.best.toFixed(0)})`),
    );
    for (const c of stat.components) {
      lines.push(
        `    ${t(c.label, lang)}  ${c.value === null ? "—" : (c.value * 100).toFixed(0)}  n=${c.denominator}`,
      );
    }
  }
  return lines.join("\n");
}

function guideText(): string {
  const s = state();
  if (s.window === null) return "구간이 없습니다 / no closed period yet";
  const advice = adviseAll(s.window.stats);
  const lines: string[] = [];
  for (const a of advice) {
    lines.push(`## ${t(a.label, lang)}  ${a.score?.toFixed(0) ?? "—"}`);
    if (a.bottleneck !== null && a.criterion !== null) {
      lines.push(`bottleneck: ${t(a.bottleneck.label, lang)}`);
      lines.push(`counts: ${t(a.criterion.measures, lang)}`);
      lines.push(`why: ${t(a.criterion.whyItMatters, lang)}`);
      lines.push("actions:");
      for (const x of tList(a.criterion.actions, lang)) lines.push(`  - ${x}`);
      // 안티패턴을 반드시 함께 낸다. 처방만 주면 가장 싼 경로가 조작이다.
      lines.push("antipatterns (raise the score, not the quality):");
      for (const x of tList(a.criterion.antipatterns, lang))
        lines.push(`  - ${x}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function diagText(): string {
  const s = state();
  const merged = mergePeriods(s.closed);
  if (merged === null) return "구간이 없습니다 / no closed period yet";
  // diag 는 DB 핸들이 필요해 여기서만 다시 연다. 창 캐시와 달리 매번 최신을 본다.
  const db = new ScouterDb(dbPath);
  try {
    return JSON.stringify(diagnosePeriod(db, merged, lang), null, 2);
  } finally {
    db.close();
  }
}

function harnessText(root: string): string {
  const inventory = scanHarness(root);
  const summary = summarizeHarness(inventory);
  const coherence = checkCoherence(inventory, ruleDocumentPaths(root));
  return JSON.stringify({ summary, coherence }, null, 2);
}

function gateText(): string {
  const s = state();
  const gate = runGate(s.result.sessions, s.result.forPeriods, lang);
  const lines = [
    `periods ${gate.periodCount}`,
    `all-time screen: ${gate.axes.filter((a) => a.supportsAllTime).length}/${gate.axes.length} axes`,
    `per-period screen: ${gate.axes.filter((a) => a.supportsPerPeriod).length}/${gate.axes.length} axes`,
    "",
  ];
  for (const axis of gate.axes) {
    const support = axis.supportsAllTime
      ? axis.supportsPerPeriod
        ? "both"
        : "all-time only"
      : "neither";
    lines.push(`${axis.axis}  ${support}`);
    for (const c of axis.checks) {
      lines.push(`    ${c.passed ? "o" : "X"} ${t(c.name, lang)}  ${c.value}`);
    }
  }
  return lines.join("\n");
}

function callTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "scouter_status":
      return statusText(String(args["scope"] ?? "all-time"));
    case "scouter_guide":
      return guideText();
    case "scouter_diag":
      return diagText();
    case "scouter_harness": {
      const root = args["root"];
      if (typeof root !== "string" || root === "") {
        throw new Error("root is required");
      }
      return harnessText(root);
    }
    case "scouter_gate":
      return gateText();
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(req: Request): void {
  // 알림에는 id 가 없다. 응답을 보내면 프로토콜 위반이다.
  const isNotification = req.id === undefined;

  try {
    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "harness-scouter", version: "0.0.1" },
        },
      });
      return;
    }
    if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
      return;
    }
    if (req.method === "tools/call") {
      const params = req.params ?? {};
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      const text = callTool(name, args);
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text }] },
      });
      return;
    }
    if (isNotification) return;
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    });
  } catch (error) {
    if (isNotification) return;
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

// 클라이언트가 먼저 끊으면 stdout 이 EPIPE 를 낸다. 응답 하나가 파이프 버퍼에 들어갈
// 만큼 작아 평소에는 안 보이지만, 버퍼를 넘길 만큼 쌓이는 순간 스택트레이스와 함께
// 죽는다. 읽을 사람이 없어진 것은 서버의 실패가 아니므로 조용히 끝낸다.
guardBrokenPipe(process.stdout, () => process.exit(0));

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let req: Request;
  try {
    req = JSON.parse(trimmed) as Request;
  } catch {
    // 파싱이 안 되면 id 를 모르므로 응답할 수 없다. 프로토콜상 조용히 버린다.
    return;
  }
  handle(req);
});
