import type {
  ArtifactRow,
  SessionEventRow,
  UsageRow,
  ExecMode,
  RawEntry,
  SessionRow,
  ToolCallRow,
  ToolResultRow,
} from "./types.js";
import { classifyBash } from "./definitions.js";

/** stdout 전체를 들고 있을 이유가 없다. verifier 성패 판정에 필요한 꼬리만 남긴다. */
const STDOUT_TAIL_CHARS = 4000;

export interface ExtractedFacts {
  sessions: Map<string, SessionRow>;
  toolCalls: ToolCallRow[];
  toolResults: ToolResultRow[];
  artifacts: ArtifactRow[];
  sessionEvents: SessionEventRow[];
  usages: UsageRow[];
  /** uuid → stdout 꼬리. tool_result와 같은 키를 쓴다. */
  stdoutTails: Map<string, string>;
}

interface ToolUseBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  /** subagent 트랜스크립트는 도구 출력을 이 필드에 바로 담는다. */
  content?: unknown;
}

/**
 * 중단 표식은 정확히 일치해야 한다.
 *
 * 부분 문자열로 보면 이 마커를 인용한 작업 지시문까지 중단으로 잡힌다.
 * 실측에서 진짜 중단 168건은 전부 이 두 형태와 정확히 일치했고, 부분 일치로 잡힌
 * 19건은 전부 마커를 본문에 인용한 사용자 메시지였다.
 */
const INTERRUPT_EXACT = /^\[Request interrupted by user( for tool use)?\]$/;

function hasInterruptMarker(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (block === null || typeof block !== "object") return false;
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" && INTERRUPT_EXACT.test(text.trim());
  });
}

function asBlocks(content: unknown): ToolUseBlock[] {
  return Array.isArray(content) ? (content as ToolUseBlock[]) : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 실행 모드를 판정한다 (설계 3.1의 층화 1차 기준).
 *
 * `entrypoint`가 유일한 근거인데 표본에서 사실상 한 값이라(vscode 274 / sdk 2)
 * 이 판정자는 지금 변별력이 거의 없다. 무인 워커 세션이 쌓이기 전까지는
 * 대부분 interactive로 떨어진다는 것을 알고 써야 한다.
 */
function detectExecMode(entrypoint: string | null): ExecMode {
  if (entrypoint === null) return "unknown";
  if (/sdk|headless|\bcli\b|print/.test(entrypoint)) return "headless";
  if (/vscode|jetbrains|terminal|desktop|web/.test(entrypoint))
    return "interactive";
  return "unknown";
}

/**
 * 파싱된 엔트리를 사실 테이블 행으로 바꾼다.
 *
 * 해석을 넣지 않는다. 축 점수는 여기서 만들지 않고 지표 계산기가 만든다.
 * 정의가 바뀔 때 전체를 재파싱하지 않으려면 이 단계가 중립이어야 한다.
 */
/**
 * `git commit` 출력의 해시. `[feature/x 9b116b7] 제목` 형태다.
 *
 * 호출 시점에는 해시를 알 수 없어 산출물 ref 를 내부 키로 두었는데, 그러면 git 과
 * 못 잇는다. 결과에서 뽑아 따로 남긴다. stdout 을 꼬리만 저장하므로 긴 출력에서는
 * 놓친다. 실측 커밋 호출 502건 중 stdout 이 있는 것이 428건, 해시가 잡히는 것이 122건이다.
 */
const COMMIT_SHA = /\[[^\]\n]*\s([0-9a-f]{7,40})\]/;

export function extractFacts(
  entries: RawEntry[],
  projectDir: string,
  sourceFile: string,
): ExtractedFacts {
  const sessions = new Map<string, SessionRow>();
  const skillsBySession = new Map<string, Set<string>>();
  const seqBySession = new Map<string, number>();
  const toolCalls: ToolCallRow[] = [];
  const toolResults: ToolResultRow[] = [];
  const artifacts: ArtifactRow[] = [];
  const sessionEvents: SessionEventRow[] = [];
  // 한 응답이 여러 줄로 오는데 output_tokens가 스트리밍이라 줄마다 커진다.
  // 첫 줄을 채택하면 생성 토큰이 통째로 과소집계된다(실측 -28.3%).
  const usageByRequest = new Map<string, UsageRow>();
  const stdoutTails = new Map<string, string>();
  const turnsBySession = new Map<string, number>();
  // 큐 개입이 주행 중인지 판정하려면 직전 assistant 응답이 도구 호출로 끝났는지 알아야 한다.
  const lastStopReason = new Map<string, string | null>();
  // enqueue가 실제로 전달됐는지는 뒤에 오는 dequeue·remove가 정한다.
  const pendingEnqueues = new Map<string, SessionEventRow[]>();
  // tool_result가 tool_use보다 뒤에 오므로 짝을 맞출 때까지 상태를 들고 있는다.
  const resultStatus = new Map<
    string,
    { isError: number; denialKind: string | null }
  >();

  for (const entry of entries) {
    const sessionId = entry.sessionId;
    if (sessionId === undefined) continue;

    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = {
        sessionId,
        project: projectDir,
        cwd: null,
        gitBranch: null,
        startedAt: null,
        endedAt: null,
        model: null,
        ccVersion: null,
        entrypoint: null,
        execMode: "unknown",
        skillsJson: "[]",
        assistantTurns: 0,
      };
      sessions.set(sessionId, session);
      skillsBySession.set(sessionId, new Set());
      seqBySession.set(sessionId, 0);
    }

    const ts = entry.timestamp ?? null;
    if (ts !== null) {
      if (session.startedAt === null || ts < session.startedAt)
        session.startedAt = ts;
      if (session.endedAt === null || ts > session.endedAt)
        session.endedAt = ts;
    }
    if (entry.cwd !== undefined) session.cwd = entry.cwd;
    if (entry.gitBranch !== undefined) session.gitBranch = entry.gitBranch;
    if (entry.version !== undefined) session.ccVersion = entry.version;
    if (entry.entrypoint !== undefined) {
      session.entrypoint = entry.entrypoint;
      session.execMode = detectExecMode(entry.entrypoint);
    }
    if (entry.message?.model !== undefined) session.model = entry.message.model;
    if (entry.attributionSkill !== undefined) {
      skillsBySession.get(sessionId)?.add(entry.attributionSkill);
    }

    if (entry.type === "queue-operation") {
      const op = entry.operation;
      const pending = pendingEnqueues.get(sessionId) ?? [];
      if (op === "enqueue") {
        // 도구 호출 중에 자판을 친 것. 도구 체인을 끊지 않으므로 interrupt에 안 잡힌다.
        const midflight = lastStopReason.get(sessionId) === "tool_use";
        const row: SessionEventRow = {
          sessionId,
          sourceFile,
          kind: midflight ? "queue_enqueue_midflight" : "queue_enqueue",
          ts,
        };
        sessionEvents.push(row);
        pending.push(row);
        pendingEnqueues.set(sessionId, pending);
      } else if (op === "remove") {
        // 큐에서 지운 입력은 모델에 전달되지 않는다. 개입으로 세면 안 된다.
        // 실측에서 remove로 끝난 enqueue 358건 중 전달된 것은 0건이었다.
        const cancelled = pending.pop();
        if (cancelled !== undefined) cancelled.kind = "queue_removed";
        sessionEvents.push({ sessionId, sourceFile, kind: "queue_remove", ts });
      } else if (op === "dequeue") {
        pending.shift();
      }
      continue;
    }

    if (entry.type === "pr-link" && entry.prNumber !== undefined) {
      artifacts.push({
        sessionId,
        sourceFile,
        kind: "pr",
        ref: String(entry.prNumber),
        ts,
      });
    }

    if (entry.type === "assistant") {
      // subagent 턴은 개입 대상이 아니다. 분모에 넣으면 위임할수록 자율성이 오른다.
      if (entry.isSidechain !== true) {
        turnsBySession.set(sessionId, (turnsBySession.get(sessionId) ?? 0) + 1);
      }
      lastStopReason.set(sessionId, entry.message?.stop_reason ?? null);

      const usage = entry.message?.usage;
      const requestId = entry.requestId;
      if (usage !== undefined && requestId !== undefined) {
        const key = `${sessionId}:${requestId}`;
        const previous = usageByRequest.get(key);
        const row: UsageRow = {
          sessionId,
          sourceFile,
          requestId,
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
          ts,
        };
        // input·cache는 줄마다 같지만 output만 누적된다. 최대값을 남긴다.
        if (previous === undefined || row.output >= previous.output) {
          usageByRequest.set(key, row);
        }
      }
      for (const block of asBlocks(entry.message?.content)) {
        if (block.type !== "tool_use") continue;
        const seq = (seqBySession.get(sessionId) ?? 0) + 1;
        seqBySession.set(sessionId, seq);
        const input = block.input ?? {};
        const name = block.name ?? "unknown";
        const command = name === "Bash" ? str(input["command"]) : null;

        toolCalls.push({
          sessionId,
          sourceFile,
          uuid: block.id ?? `${sessionId}:${seq}`,
          seq,
          name,
          ts,
          isError: null,
          denialKind: null,
          command,
          filePath: str(input["file_path"]),
          readOffset: num(input["offset"]),
          readLimit: num(input["limit"]),
          isSidechain: entry.isSidechain === true ? 1 : 0,
          agentId: entry.agentId ?? null,
        });

        if (command !== null && classifyBash(command).isCommit) {
          artifacts.push({
            sessionId,
            sourceFile,
            kind: "commit",
            ref: `${sourceFile}:${seq}`,
            ts,
          });
        }
      }
      continue;
    }

    if (entry.type !== "user") continue;

    // 중단 표식은 문자열 content에도 오고 text 블록 안에도 온다. 둘 다 봐야 한다.
    if (hasInterruptMarker(entry.message?.content)) {
      sessionEvents.push({ sessionId, sourceFile, kind: "interrupt", ts });
    }

    const denialKind = entry.toolDenialKind ?? null;
    for (const block of asBlocks(entry.message?.content)) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id;
      if (id === undefined) continue;
      const result = extractToolResult(
        sessionId,
        sourceFile,
        id,
        entry.toolUseResult,
        block.content,
      );
      toolResults.push(result);
      const tail = extractStdoutTail(entry.toolUseResult, block.content);
      if (tail !== null) {
        stdoutTails.set(id, tail);
        // 커밋 해시는 도구 결과에만 있다. 호출 시점의 산출물 ref 는 중복제거용
        // 내부 키라서 git 과 잇지 못한다. 타당성 검증을 사람 라벨이 아니라 결과로
        // 하려면 실제 해시가 필요하다.
        const sha = COMMIT_SHA.exec(tail)?.[1];
        if (sha !== undefined) {
          artifacts.push({
            sessionId,
            sourceFile,
            kind: "commit-sha",
            ref: sha,
            ts,
          });
        }
      }
      resultStatus.set(id, {
        isError: block.is_error === true ? 1 : 0,
        denialKind,
      });
    }
  }

  for (const call of toolCalls) {
    const status = resultStatus.get(call.uuid);
    if (status !== undefined) {
      call.isError = status.isError;
      call.denialKind = status.denialKind;
    }
  }

  for (const [sessionId, skills] of skillsBySession) {
    const session = sessions.get(sessionId);
    if (session !== undefined) session.skillsJson = JSON.stringify([...skills]);
  }
  for (const [sessionId, turns] of turnsBySession) {
    const session = sessions.get(sessionId);
    if (session !== undefined) session.assistantTurns = turns;
  }

  return {
    sessions,
    toolCalls,
    toolResults,
    artifacts,
    sessionEvents,
    usages: [...usageByRequest.values()],
    stdoutTails,
  };
}

/**
 * `cat -n` 형식 본문에서 줄 정보를 복원한다.
 *
 * subagent 트랜스크립트에는 `toolUseResult` 가 아예 없다. 파일 정보가 담긴 그 객체가
 * 메인 세션에만 붙어서, Read 결과의 60%(7,805건)가 총 줄 수를 잃고 있었다. 읽기 범위
 * 규율이 실제 읽기의 절반만 보고 있었다는 뜻이다.
 *
 * 다행히 본문이 `   12\t내용` 형식이라 첫 줄과 끝 줄의 번호로 되살릴 수 있다. 총 줄 수는
 * 알 수 없고(파일 끝까지 읽었는지 모른다) 읽은 범위만 알 수 있어, 끝 줄 번호를 하한으로
 * 쓴다. 하한이라 부분읽기를 전체읽기로 잘못 볼 위험은 없고 그 반대만 있다.
 */
function linesFromNumberedBody(content: unknown): {
  numLines: number;
  startLine: number;
  lastLine: number;
} | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b) =>
              b !== null && typeof b === "object" && "text" in b
                ? String((b as { text: unknown }).text)
                : "",
            )
            .join("")
        : "";
  if (text === "") return null;

  const rows = text.split("\n");
  const numbered = /^\s*(\d+)\t/;
  let first: number | null = null;
  let last: number | null = null;
  let count = 0;
  for (const row of rows) {
    const m = numbered.exec(row);
    if (m === null) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    first ??= n;
    last = n;
    count += 1;
  }
  // 번호가 붙은 줄이 태반이어야 Read 본문으로 본다. bash 출력이 우연히 걸리는 것을 막는다.
  if (first === null || last === null || count < 3 || count * 2 < rows.length) {
    return null;
  }
  return { numLines: count, startLine: first, lastLine: last };
}

function extractToolResult(
  sessionId: string,
  sourceFile: string,
  uuid: string,
  raw: unknown,
  blockContent?: unknown,
): ToolResultRow {
  const row: ToolResultRow = {
    sessionId,
    sourceFile,
    uuid,
    totalLines: null,
    numLines: null,
    startLine: null,
    editType: null,
    subagentToolCalls: null,
    subagentEditFiles: null,
  };
  // toolUseResult 가 없거나 file 정보가 비면 본문으로 되살린다.
  //
  // subagent 트랜스크립트에는 toolUseResult 자체가 없어서 아래 조기 반환에 걸린다.
  // 그래서 반환 전에 먼저 본문을 본다.
  const fillFromBody = (): void => {
    if (row.totalLines !== null || blockContent === undefined) return;
    const fromBody = linesFromNumberedBody(blockContent);
    if (fromBody === null) return;
    row.numLines = fromBody.numLines;
    row.startLine = fromBody.startLine;
    // 총 줄 수는 모른다. 끝 줄 번호가 하한이다.
    row.totalLines = fromBody.lastLine;
  };

  if (raw === null || typeof raw !== "object") {
    fillFromBody();
    return row;
  }
  const obj = raw as Record<string, unknown>;

  const file = obj["file"];
  if (file !== null && typeof file === "object") {
    const f = file as Record<string, unknown>;
    row.totalLines = num(f["totalLines"]);
    row.numLines = num(f["numLines"]);
    row.startLine = num(f["startLine"]);
  }

  fillFromBody();

  const kind = obj["type"];
  if (kind === "create" || kind === "update" || kind === "file_unchanged") {
    row.editType = kind;
  }

  // subagent 결과. 내부 턴은 안 남지만 집계는 남는다 (설계 9절).
  row.subagentToolCalls = num(obj["totalToolUseCount"]);
  const stats = obj["toolStats"];
  if (stats !== null && typeof stats === "object") {
    row.subagentEditFiles = num(
      (stats as Record<string, unknown>)["editFileCount"],
    );
  }

  return row;
}

function tail(text: string): string | null {
  if (text.length === 0) return null;
  return text.length > STDOUT_TAIL_CHARS
    ? text.slice(-STDOUT_TAIL_CHARS)
    : text;
}

/**
 * 도구 출력의 꼬리. 두 자리를 다 봐야 한다.
 *
 * 메인 트랜스크립트는 `toolUseResult.stdout` 에 담고, subagent 트랜스크립트는
 * `tool_result` 블록의 `content` 문자열에 바로 담는다. 앞쪽만 보고 있어서
 * subagent 의 Bash 출력 13,245건이 통째로 안 잡혔다(수집률 0%). graphify 호출의
 * 83%가 subagent 라 그쪽 적중률을 아예 못 재는 상태였다.
 */
function extractStdoutTail(
  raw: unknown,
  blockContent?: unknown,
): string | null {
  if (raw !== null && typeof raw === "object") {
    const stdout = (raw as Record<string, unknown>)["stdout"];
    if (typeof stdout === "string") {
      const t = tail(stdout);
      if (t !== null) return t;
    }
  }
  if (typeof blockContent === "string") return tail(blockContent);
  if (Array.isArray(blockContent)) {
    const text = blockContent
      .filter(
        (b): b is { type?: string; text?: string } =>
          b !== null && typeof b === "object",
      )
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("\n")
      .trim();
    return tail(text);
  }
  return null;
}
