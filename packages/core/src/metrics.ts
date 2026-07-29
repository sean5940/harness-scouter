import type { ToolCallRecord } from "./db.js";
import {
  classifyBash,
  isEffectivePartialRead,
  isCodeFile,
  isNonTextFile,
  INDEXED_SEARCH_TOOL_PATTERN,
  LARGE_FILE_LINES,
  SCANNING_SEARCH_TOOLS,
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
  /** 훅·권한에 막혀 실행되지 않은 호출 수. 축에서 빼되 진단에는 남긴다. */
  blockedCalls: number;
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
 * 에이전트 하나의 읽기 이력.
 *
 * 세션 하나에 메인 에이전트와 여러 subagent가 섞여 있고 각자 컨텍스트가 따로다.
 * 병렬 subagent 둘이 같은 파일을 한 번씩 읽은 것은 왕복이 아니므로 축2는 에이전트별로 센다.
 */
interface ReadState {
  lastRead: Map<string, number>;
  lastEdit: Map<string, number>;
}

/**
 * 커밋 세그먼트 상태. 축2와 달리 **세션 단위**다.
 *
 * subagent가 코드를 고치고 메인이 커밋하는 흐름이 흔한데, 에이전트별로 두면 그 커밋이
 * 분모에서 통째로 빠진다. 실측에서 메인 커밋 438건 중 198건이 그렇게 탈락했고,
 * subagent를 쓰는 세션과 안 쓰는 세션의 탈락률 격차가 19.1%p였다.
 */
interface CommitSegment {
  lastCodeEdit: number;
  lastVerifier: number;
  hasCodeEdit: boolean;
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
  calls: ToolCallRecord[]
): SessionMetrics {
  const axes = emptyAxes();
  const coverage: CoverageCount = { observable: 0, offChannel: 0, opaque: 0 };
  let verifierOutcomeUnknown = 0;
  let blockedCalls = 0;

  const hasSidechainRecords = calls.some((c) => c.is_sidechain === 1);
  const readStates = new Map<string, ReadState>();
  const segment: CommitSegment = {
    lastCodeEdit: -1,
    lastVerifier: -1,
    hasCodeEdit: false,
  };
  const blockKinds = new Map<string, Set<string>>();

  // 순서 키는 저장된 seq가 아니라 정렬된 스트림의 위치를 쓴다.
  // seq는 파일마다 1부터 다시 매겨져 한 세션 안에서 되감기고, 그러면 "편집 이후 검증"
  // 같은 순서 비교가 조용히 뒤집힌다.
  let order = 0;

  for (const call of calls) {
    order += 1;

    // 훅이나 권한에 막힌 호출은 실행되지 않았다. 축에 넣으면 게이트가 잘 작동할수록
    // 점수가 나빠지는 역설이 생긴다. 실제로 축5b 분자의 상당수가 이 프로젝트 자신의
    // 검색 게이트가 막은 호출이었다.
    if (call.denial_kind !== null) {
      blockedCalls += 1;
      continue;
    }

    const { name } = call;
    const agentKey = call.agent_id ?? "main";
    let reads = readStates.get(agentKey);
    if (reads === undefined) {
      reads = { lastRead: new Map(), lastEdit: new Map() };
      readStates.set(agentKey, reads);
    }

    if (name === "Read") {
      coverage.observable += 1;
      const path = call.file_path;
      if (path !== null && !isNonTextFile(path)) {
        if ((call.total_lines ?? 0) > LARGE_FILE_LINES) {
          axes.readScope.den += 1;
          if (
            isEffectivePartialRead(
              call.total_lines,
              call.num_lines,
              call.start_line
            )
          ) {
            axes.readScope.num += 1;
          }
        }

        axes.readRevisit.den += 1;
        const previousRead = reads.lastRead.get(path);
        if (previousRead !== undefined) {
          const editedSince = reads.lastEdit.get(path);
          const isLegitimateRecheck =
            editedSince !== undefined && editedSince > previousRead;
          if (!isLegitimateRecheck) axes.readRevisit.num += 1;
        }
        reads.lastRead.set(path, order);
      }
      continue;
    }

    if (EDIT_TOOLS.has(name)) {
      coverage.observable += 1;
      axes.instrumentedChannel.den += 1;
      const path = call.file_path;
      if (path !== null) {
        reads.lastEdit.set(path, order);
        if (isCodeFile(path)) {
          segment.lastCodeEdit = order;
          segment.hasCodeEdit = true;
        }
      }
      blockKinds.set(agentKey, new Set());
      continue;
    }

    if (name === "Agent" || name === "Task") {
      if (!hasSidechainRecords) {
        coverage.opaque += call.subagent_tool_calls ?? 0;
        axes.instrumentedChannel.den += call.subagent_edit_files ?? 0;
      }
      continue;
    }

    if (SCANNING_SEARCH_TOOLS.has(name)) {
      // 계측 채널이지만 하는 일은 전수 스캔이다. 축이 묻는 것은 인덱스를 먼저 봤는가다.
      axes.indexedRetrieval.den += 1;
      axes.indexedRetrieval.num += 1;
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
      // 축3은 코드 편집만 센다. 대상을 못 뽑았으면 코드로 보지 않는다.
      // 그래야 문서를 bash로 고친 것이 커밋 분모에 들어가지 않는다.
      if (isCodeFile(kind.fileWriteTarget)) {
        segment.lastCodeEdit = order;
        segment.hasCodeEdit = true;
      }
      blockKinds.set(agentKey, new Set());
    }

    if (kind.isRecursiveSearch) {
      axes.indexedRetrieval.den += 1;
      axes.indexedRetrieval.num += 1;
    }

    if (kind.verifierKinds.length > 0) {
      segment.lastVerifier = order;
      const seen = blockKinds.get(agentKey) ?? new Set<string>();
      for (const vk of kind.verifierKinds) {
        axes.verificationRedundancy.den += 1;
        if (seen.has(vk)) axes.verificationRedundancy.num += 1;
        else seen.add(vk);
      }
      blockKinds.set(agentKey, seen);
      if (call.stdout_tail === null) verifierOutcomeUnknown += 1;
    }

    if (kind.isCommit && !kind.isCommitAmend) {
      if (segment.hasCodeEdit) {
        axes.verificationFreshness.den += 1;
        if (segment.lastVerifier > segment.lastCodeEdit) {
          axes.verificationFreshness.num += 1;
        }
      }
      segment.lastCodeEdit = -1;
      segment.lastVerifier = -1;
      segment.hasCodeEdit = false;
    }
  }

  return { sessionId, axes, coverage, verifierOutcomeUnknown, blockedCalls };
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
