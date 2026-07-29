import type { ToolCallRecord } from "./db.js";
import {
  classifyBash,
  isEffectivePartialRead,
  isCodeFile,
  isNonTextFile,
  INDEXED_SEARCH_TOOL_PATTERN,
  LARGE_FILE_LINES,
  type AxisKey,
} from "./definitions.js";

export interface AxisCount {
  num: number;
  den: number;
}

export type AxisCounts = Record<AxisKey, AxisCount>;

export interface CoverageCount {
  observable: number;
  offChannel: number;
  opaque: number;
}

export interface SessionMetrics {
  sessionId: string;
  axes: AxisCounts;
  coverage: CoverageCount;
  /** 성패를 못 가린 verifier 호출 수. 축4 해석의 신뢰도 표시에 쓴다. */
  verifierOutcomeUnknown: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export function emptyAxes(): AxisCounts {
  return {
    readScope: { num: 0, den: 0 },
    readRevisit: { num: 0, den: 0 },
    verificationFreshness: { num: 0, den: 0 },
    verificationRedundancy: { num: 0, den: 0 },
    instrumentedChannel: { num: 0, den: 0 },
    indexedRetrieval: { num: 0, den: 0 },
  };
}

/**
 * 한 에이전트 컨텍스트의 진행 상태.
 *
 * 세션 하나에 메인 에이전트와 여러 subagent가 섞여 있고 각자 컨텍스트가 따로다.
 * 상태를 세션 단위로 두면 병렬 subagent 둘이 같은 파일을 한 번씩 읽은 것이
 * "같은 파일을 두 번 읽었다"로 잡힌다. 서로의 컨텍스트를 볼 수 없으므로 왕복이 아니다.
 */
interface AgentState {
  lastReadSeq: Map<string, number>;
  lastEditSeq: Map<string, number>;
  segmentLastCodeEdit: number;
  segmentLastVerifier: number;
  segmentHasCodeEdit: boolean;
  blockVerifierKinds: Set<string>;
}

function newAgentState(): AgentState {
  return {
    lastReadSeq: new Map(),
    lastEditSeq: new Map(),
    segmentLastCodeEdit: -1,
    segmentLastVerifier: -1,
    segmentHasCodeEdit: false,
    blockVerifierKinds: new Set(),
  };
}

/**
 * 세션 하나에서 6축의 분자·분모를 센다. 점수(비율)는 여기서 만들지 않는다.
 *
 * 구간 집계가 세션 비율의 평균이 아니라 분자·분모의 합이어야 하기 때문이다.
 * 세션마다 분모가 2건에서 200건까지 흔들리는데 비율을 먼저 내고 평균하면
 * 이벤트 2건짜리 세션이 200건짜리와 같은 무게를 갖는다.
 */
export function computeSessionMetrics(
  sessionId: string,
  calls: ToolCallRecord[],
): SessionMetrics {
  const axes = emptyAxes();
  const coverage: CoverageCount = { observable: 0, offChannel: 0, opaque: 0 };
  let verifierOutcomeUnknown = 0;

  // subagent 트랜스크립트가 별도 파일로 남아 있으면 그 호출을 직접 센다.
  // 없을 때만 결과에 실린 집계치로 대신한다. 둘 다 쓰면 같은 활동을 두 번 센다.
  const hasSidechainRecords = calls.some((c) => c.is_sidechain === 1);
  const states = new Map<string, AgentState>();

  for (const call of calls) {
    const { name, seq } = call;
    const agentKey = call.agent_id ?? "main";
    let state = states.get(agentKey);
    if (state === undefined) {
      state = newAgentState();
      states.set(agentKey, state);
    }

    if (name === "Read") {
      coverage.observable += 1;
      const path = call.file_path;
      if (path !== null && !isNonTextFile(path)) {
        // 축1: 큰 파일만 분모에 넣는다. 작은 파일을 통째로 읽는 것은 규율 위반이 아니다.
        if ((call.total_lines ?? 0) > LARGE_FILE_LINES) {
          axes.readScope.den += 1;
          if (
            isEffectivePartialRead(
              call.total_lines,
              call.num_lines,
              call.start_line,
            )
          ) {
            axes.readScope.num += 1;
          }
        }

        // 축2: 같은 경로를 다시 읽었는가. 그 사이에 그 파일을 고쳤으면 정당한 재확인이다.
        axes.readRevisit.den += 1;
        const previousRead = state.lastReadSeq.get(path);
        if (previousRead !== undefined) {
          const editedSince = state.lastEditSeq.get(path);
          const isLegitimateRecheck =
            editedSince !== undefined && editedSince > previousRead;
          if (!isLegitimateRecheck) axes.readRevisit.num += 1;
        }
        state.lastReadSeq.set(path, seq);
      }
      continue;
    }

    if (EDIT_TOOLS.has(name)) {
      coverage.observable += 1;
      axes.instrumentedChannel.den += 1;
      const path = call.file_path;
      if (path !== null) {
        state.lastEditSeq.set(path, seq);
        if (isCodeFile(path)) {
          state.segmentLastCodeEdit = seq;
          state.segmentHasCodeEdit = true;
        }
      }
      state.blockVerifierKinds = new Set();
      continue;
    }

    if (name === "Agent" || name === "Task") {
      if (!hasSidechainRecords) {
        // 트랜스크립트가 없는 세션. 결과에 실린 집계치로 위임분을 근사한다.
        coverage.opaque += call.subagent_tool_calls ?? 0;
        axes.instrumentedChannel.den += call.subagent_edit_files ?? 0;
      }
      continue;
    }

    if (INDEXED_SEARCH_TOOL_PATTERN.test(name)) {
      axes.indexedRetrieval.den += 1;
      continue;
    }

    if (name !== "Bash") continue;

    const kind = classifyBash(call.command);

    if (kind.isSourceRead) {
      coverage.offChannel += 1;
      axes.instrumentedChannel.den += 1;
      axes.instrumentedChannel.num += 1;
    }
    if (kind.fileWriteRule !== null) {
      coverage.offChannel += 1;
      axes.instrumentedChannel.den += 1;
      axes.instrumentedChannel.num += 1;
      // bash로 판 파일도 편집이므로 축3의 segment 상태를 갱신한다.
      state.segmentLastCodeEdit = seq;
      state.segmentHasCodeEdit = true;
      state.blockVerifierKinds = new Set();
    }

    if (kind.isRecursiveSearch) {
      axes.indexedRetrieval.den += 1;
      axes.indexedRetrieval.num += 1;
    }

    if (kind.verifierKinds.length > 0) {
      state.segmentLastVerifier = seq;
      for (const vk of kind.verifierKinds) {
        axes.verificationRedundancy.den += 1;
        if (state.blockVerifierKinds.has(vk))
          axes.verificationRedundancy.num += 1;
        else state.blockVerifierKinds.add(vk);
      }
      if (call.stdout_tail === null) verifierOutcomeUnknown += 1;
    }

    if (kind.isCommit && !kind.isCommitAmend) {
      // 코드 편집이 없는 커밋은 분모에서 뺀다. 문서 커밋을 넣으면 축이 붕괴한다.
      if (state.segmentHasCodeEdit) {
        axes.verificationFreshness.den += 1;
        if (state.segmentLastVerifier > state.segmentLastCodeEdit) {
          axes.verificationFreshness.num += 1;
        }
      }
      state.segmentLastCodeEdit = -1;
      state.segmentLastVerifier = -1;
      state.segmentHasCodeEdit = false;
    }
  }

  return { sessionId, axes, coverage, verifierOutcomeUnknown };
}

/**
 * 축 값은 전부 "높을수록 좋음"으로 맞춘다.
 * 레이더에서 바깥으로 넓어지는 것이 개선으로 읽히려면 방향이 통일돼야 한다 (설계 7.1).
 */
const INVERTED_AXES = new Set<AxisKey>([
  "readRevisit",
  "verificationRedundancy",
  "instrumentedChannel",
  "indexedRetrieval",
]);

export function axisScore(key: AxisKey, count: AxisCount): number | null {
  if (count.den === 0) return null;
  const ratio = count.num / count.den;
  return INVERTED_AXES.has(key) ? 1 - ratio : ratio;
}

export function addCounts(target: AxisCounts, source: AxisCounts): void {
  for (const key of Object.keys(target) as AxisKey[]) {
    target[key].num += source[key].num;
    target[key].den += source[key].den;
  }
}

export function coverageRatio(c: CoverageCount): number | null {
  const total = c.observable + c.offChannel + c.opaque;
  return total === 0 ? null : c.observable / total;
}
