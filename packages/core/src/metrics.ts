import type { ToolCallRecord } from "./db.js";
import {
  createResolver,
  CLAUDE_CODE_PROFILE,
  type CapabilityResolver,
} from "./capability.js";
import { searchTermOf } from "./bash.js";
import {
  classifyBash,
  isEffectivePartialRead,
  isCodeFile,
  isNonTextFile,
  isIndexedSearchTool,
  isExistingFileEdit,
  verifierOutcome,
  LARGE_FILE_LINES,
  CONTENT_SCAN_TOOLS,
  FILE_FIND_TOOLS,
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

/** 능력치 합성에만 쓰는 보조 신호. 축이 아니라 구성요소다. */
export interface ExtraCounts {
  /** 체크포인트(검증·커밋)를 넘긴 뒤 같은 파일을 다시 고친 비율 */
  rework: AxisCount;
  /** 세션 내 같은 검색 명령을 다시 돌린 비율 */
  searchRepeat: AxisCount;
  /** 훅·권한에 막힌 호출 비율 */
  ruleFriction: AxisCount;
  /**
   * 차단 중 이미 걸린 적 있는 게이트에 다시 걸린 것.
   * 차단이 있어야 분모가 생기므로 센서 없는 하네스는 만점이 아니라 판정 불가다.
   */
  gateRepeat: AxisCount;
  /** 파일 찾기를 계측 도구(Glob)로 한 비율. `find -name` 이 분모의 나머지다. */
  fileFind: AxisCount;
  /** 기존 파일 편집 중 그 파일을 먼저 읽은 비율. 새로 만든 파일은 분모에서 뺀다. */
  groundedEdit: AxisCount;
  askQuestions: number;
  assistantTurns: number;
  codeEdits: number;
}

/**
 * 프로필이 알아본 호출 수. 미매핑은 이름별로 남겨 무엇을 프로필에 더할지 바로 보이게 한다.
 */
export interface CapabilityCounts {
  total: number;
  mapped: number;
  /** 미매핑 도구 이름 → 횟수. 구간으로 합칠 때 더해진다. */
  unmapped: Record<string, number>;
}

export function emptyCapability(): CapabilityCounts {
  return { total: 0, mapped: 0, unmapped: {} };
}

export function addCapability(
  a: CapabilityCounts,
  b: CapabilityCounts,
): CapabilityCounts {
  const unmapped = { ...a.unmapped };
  for (const [name, n] of Object.entries(b.unmapped)) {
    unmapped[name] = (unmapped[name] ?? 0) + n;
  }
  return {
    total: a.total + b.total,
    mapped: a.mapped + b.mapped,
    unmapped,
  };
}

export interface SessionMetrics {
  sessionId: string;
  axes: AxisCounts;
  extras: ExtraCounts;
  coverage: CoverageCount;
  /**
   * 활성 프로필이 이 세션의 도구 호출을 얼마나 알아봤는가.
   *
   * 축과 따로 센다. 축은 "얼마나 잘했나"를 재고 이것은 "그 값을 믿어도 되나"를 잰다.
   * 다른 하네스에서 낮은 점수가 나올 때, 나쁜 것인지 안 보이는 것인지를 이 값이 가른다.
   */
  capability: CapabilityCounts;
  /** 성패를 못 가린 verifier 호출 수. 축4 해석의 신뢰도 표시에 쓴다. */
  verifierOutcomeUnknown: number;
  /** 훅·권한에 막혀 실행되지 않은 호출 수. 축에서 빼되 진단에는 남긴다. */
  blockedCalls: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/**
 * 이 검증이 이번 세그먼트에서 고친 것을 덮는가.
 *
 * 대상이 비면 프로젝트 전체를 본 것이라 무엇을 고쳤든 덮는다. 코퍼스의 검증 대다수가
 * 이쪽이다(`npm run typecheck`·`npx vitest run`). 대상이 있으면 그 아래만 본 것이라,
 * 고친 파일이 그 안에 있어야 한다.
 *
 * 경로 비교는 꼬리 일치로 한다. 편집은 절대경로로 들어오고 검증 명령은 저장소 기준
 * 상대경로를 쓰는 것이 보통이라, 앞에서 맞추면 전부 어긋난다.
 *
 * 고친 것을 못 뽑았으면(경로 없는 편집) 덮는 것으로 본다. 틀리는 방향을 관대한 쪽에
 * 두어야 정상적인 검증이 파싱 실패로 신선도를 잃지 않는다.
 */
function verifierCoversEdits(
  targets: string[],
  segment: { editedPaths: string[] },
): boolean {
  if (targets.length === 0) return true;
  if (segment.editedPaths.length === 0) return true;
  return segment.editedPaths.some((edited) =>
    targets.some((target) => {
      // 글롭은 첫 와일드카드 앞까지를 디렉토리로 본다. `app/**/*.tsx` → `app/`
      // 틸데는 떼어낸다. 편집은 절대경로로 들어오는데 명령은 `cd ~/Source/x` 를 쓰는
      // 것이 흔해서, 그대로 두면 같은 저장소인데도 하나도 안 맞아 정상 검증이
      // 통째로 신선도를 잃는다. 실측에서 이 한 글자로 94건 중 18건이 갈렸다.
      const base = (target.split("*")[0] ?? "")
        .replace(/^~/, "")
        .replace(/\/+$/, "");
      if (base === "") return true;
      return (
        edited === base || edited.includes(`${base}/`) || edited.endsWith(base)
      );
    }),
  );
}

/**
 * 재검색으로 볼 창 크기.
 *
 * 같은 것을 "다시" 찾았다고 하려면 시간적으로 붙어 있어야 한다. 창이 없으면 세션이
 * 길수록 반복률이 기계적으로 오른다.
 */
const SEARCH_REPEAT_WINDOW = 10;

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
  /**
   * 이 세그먼트에서 고친 파일 경로.
   *
   * 검증이 겨눈 경로와 대조한다. 이게 없으면 50개를 고치고 무관한 파일 하나에 검증을
   * 돌려도 신선한 것으로 잡힌다.
   */
  editedPaths: string[];
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
  resolver: CapabilityResolver = createResolver(CLAUDE_CODE_PROFILE),
): SessionMetrics {
  const axes = emptyAxes();
  const coverage: CoverageCount = { observable: 0, offChannel: 0, opaque: 0 };
  const capability = emptyCapability();
  let verifierOutcomeUnknown = 0;
  let blockedCalls = 0;

  const extras: ExtraCounts = {
    rework: { num: 0, den: 0 },
    searchRepeat: { num: 0, den: 0 },
    ruleFriction: { num: 0, den: 0 },
    gateRepeat: { num: 0, den: 0 },
    fileFind: { num: 0, den: 0 },
    groundedEdit: { num: 0, den: 0 },
    askQuestions: 0,
    assistantTurns: 0,
    codeEdits: 0,
  };
  // 체크포인트 이후 재작업 판정용. 에이전트별로 둔다.
  // 세션 전역으로 두면 다른 worktree 에서 도는 subagent 의 검증이 메인이 편집 중이던
  // 파일의 체크포인트가 되어 재작업이 과대계상된다.
  const editedBefore = new Map<string, number>();
  const lastCheckpoint = new Map<string, number>();
  // 검색어를 세션 내내 누적하면 검색을 많이 할수록 반복률이 저절로 오른다
  // (실측 2.0% → 16.7%, 8배). 100번째 검색이 첫 검색과 겹치는 것은 못 찾은 것이 아니라
  // 다른 작업이다. 최근 창 안에서 겹칠 때만 재검색으로 센다.
  const recentSearches = new Map<string, number>();
  let searchOrder = 0;

  const hasSidechainRecords = calls.some((c) => c.is_sidechain === 1);
  const readStates = new Map<string, ReadState>();
  const segment: CommitSegment = {
    lastCodeEdit: -1,
    lastVerifier: -1,
    hasCodeEdit: false,
    editedPaths: [],
  };
  const blockKinds = new Map<string, Set<string>>();

  // 순서 키는 저장된 seq가 아니라 정렬된 스트림의 위치를 쓴다.
  // seq는 파일마다 1부터 다시 매겨져 한 세션 안에서 되감기고, 그러면 "편집 이후 검증"
  // 같은 순서 비교가 조용히 뒤집힌다.
  let order = 0;

  const gatesSeen = new Map<string, Set<string>>();
  const agentKeyOf = (c: ToolCallRecord): string => c.agent_id ?? "main";
  /** 어느 게이트인가. 같은 게이트를 또 건드렸는지 보려면 신원이 필요하다. */
  const gateSubjectOf = (c: ToolCallRecord): string => {
    if (c.name !== "Bash" || c.command === null) return c.name;
    const head = c.command.trim().split(/\s+/)[0] ?? "bash";
    return head.split("/").pop() ?? head;
  };

  for (const call of calls) {
    order += 1;

    // 프로필이 이 호출을 알아보는가. 축 계산과 무관하게 전부 센다.
    // 차단된 호출도 관측된 호출이므로 아래 continue 앞에서 센다.
    capability.total += 1;
    if (resolver.resolve(call.name, call.command) === null) {
      capability.unmapped[call.name] =
        (capability.unmapped[call.name] ?? 0) + 1;
    } else {
      capability.mapped += 1;
    }

    // 훅이나 권한에 막힌 호출은 실행되지 않았다. 축에 넣으면 게이트가 잘 작동할수록
    // 점수가 나빠지는 역설이 생긴다. 실제로 축5b 분자의 상당수가 이 프로젝트 자신의
    // 검색 게이트가 막은 호출이었다.
    extras.ruleFriction.den += 1;
    if (call.denial_kind !== null) {
      blockedCalls += 1;
      extras.ruleFriction.num += 1;
      // 같은 게이트에 또 걸렸는가. 차단 건수 자체는 해석이 안 된다. 훅을 하나도 안 깐
      // 하네스가 차단 0건으로 만점을 받기 때문이다. 재발률은 차단이 있어야 분모가
      // 생기므로 센서 없는 하네스가 만점이 아니라 판정 불가가 된다.
      // 에이전트별로 본다. 다른 에이전트는 서로의 차단 이력을 못 본다.
      const gateId = `${call.denial_kind}|${gateSubjectOf(call)}`;
      const agentGates = gatesSeen.get(agentKeyOf(call));
      if (agentGates === undefined) {
        gatesSeen.set(agentKeyOf(call), new Set([gateId]));
      } else {
        if (agentGates.has(gateId)) extras.gateRepeat.num += 1;
        agentGates.add(gateId);
      }
      extras.gateRepeat.den += 1;
      continue;
    }

    if (call.name === "AskUserQuestion") extras.askQuestions += 1;

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
              call.start_line,
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
        // 같은 파일을 체크포인트 넘어서 다시 고쳤으면 재작업이다. 같은 패스 안의
        // 여러 hunk 편집은 정상이라 체크포인트를 기준으로 가른다.
        extras.rework.den += 1;
        const reworkKey = `${agentKey} ${path}`;
        const previousEdit = editedBefore.get(reworkKey);
        const checkpoint = lastCheckpoint.get(agentKey) ?? -1;
        if (previousEdit !== undefined && checkpoint > previousEdit) {
          extras.rework.num += 1;
        }
        editedBefore.set(reworkKey, order);
        // 근거 확보율. 새로 만든 파일은 읽을 것이 없으므로 분모에서 뺀다.
        // 탐색력이 "검색한 것들 중 비율"만 보면 아예 안 찾고 고친 경우를 못 잡는다.
        if (isExistingFileEdit(name, call.edit_type) && isCodeFile(path)) {
          extras.groundedEdit.den += 1;
          if (reads.lastRead.has(path)) extras.groundedEdit.num += 1;
        }
        reads.lastEdit.set(path, order);
        if (isCodeFile(path)) {
          extras.codeEdits += 1;
          segment.lastCodeEdit = order;
          segment.hasCodeEdit = true;
          segment.editedPaths.push(path);
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

    if (CONTENT_SCAN_TOOLS.has(name)) {
      // 계측 채널이지만 하는 일은 내용 전수 스캔이다.
      axes.indexedRetrieval.den += 1;
      axes.indexedRetrieval.num += 1;
      continue;
    }

    if (FILE_FIND_TOOLS.has(name)) {
      // 파일 찾기의 옳은 대안. `find -name` 대신 이걸 쓰면 점수가 오른다.
      extras.fileFind.den += 1;
      extras.fileFind.num += 1;
      continue;
    }

    if (isIndexedSearchTool(name)) {
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
        if (kind.fileWriteTarget !== null)
          segment.editedPaths.push(kind.fileWriteTarget);
      }
      blockKinds.set(agentKey, new Set());
    }

    if (kind.isFileFind) {
      // 파일 찾기는 인덱스로 대체할 수 없다. Glob 과 같은 분모에서 비교한다.
      extras.fileFind.den += 1;
    }

    // CLI 로 부른 인덱스 검색. MCP 도구 이름만 세면 graphify 호출의 99%가 빠진다.
    if (kind.isIndexedSearch) {
      axes.indexedRetrieval.den += 1;
    }

    if (kind.isContentSearch) {
      axes.indexedRetrieval.den += 1;
      axes.indexedRetrieval.num += 1;
      // 같은 대상을 또 찾는 것은 첫 검색이 원하는 것을 못 찾았다는 뜻이다.
      // 명령 전체가 아니라 검색어로 비교한다. 경로·플래그는 바꾸면서 term은 유지하기 때문이다.
      const term = searchTermOf(call.command);
      if (term !== null) {
        searchOrder += 1;
        extras.searchRepeat.den += 1;
        const previous = recentSearches.get(term);
        if (
          previous !== undefined &&
          searchOrder - previous <= SEARCH_REPEAT_WINDOW
        ) {
          extras.searchRepeat.num += 1;
        }
        recentSearches.set(term, searchOrder);
      }
    }

    if (kind.verifierKinds.length > 0) {
      // 같은 호출에 커밋이 있으면 순서를 본다. 커밋 뒤에만 검증이 있는 호출은
      // 커밋된 트리를 검증한 것이 아니라서 신선도의 근거가 못 된다.
      // 무엇을 겨눴는지도 본다. 고친 파일을 안 덮는 검증은 그 트리를 안 본 것이다.
      // 결과도 본다. 에러를 낸 검증 위에 올린 커밋은 검증된 트리가 아니다.
      // 성패를 못 가린 것은 통과 쪽으로 둔다. 조용히 통과하는 tsc 가 출력이 아예 없어서,
      // 판정 불가를 실패로 보면 정상 검증이 통째로 신선도를 잃는다.
      const orderOk = !kind.isCommit || kind.hasVerifierBeforeCommit;
      const notFailed = verifierOutcome(call.stdout_tail) !== "fail";
      if (
        orderOk &&
        notFailed &&
        verifierCoversEdits(kind.verifierTargets, segment)
      ) {
        segment.lastVerifier = order;
      }
      const seen = blockKinds.get(agentKey) ?? new Set<string>();
      for (const vk of kind.verifierKinds) {
        axes.verificationRedundancy.den += 1;
        if (seen.has(vk)) axes.verificationRedundancy.num += 1;
        else seen.add(vk);
      }
      blockKinds.set(agentKey, seen);
      if (call.stdout_tail === null) verifierOutcomeUnknown += 1;
      lastCheckpoint.set(agentKey, order);
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
      segment.editedPaths.length = 0;
      lastCheckpoint.set(agentKey, order);
    }
  }

  return {
    sessionId,
    axes,
    extras,
    coverage,
    capability,
    verifierOutcomeUnknown,
    blockedCalls,
  };
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

export function addExtras(target: ExtraCounts, source: ExtraCounts): void {
  target.fileFind.num += source.fileFind.num;
  target.fileFind.den += source.fileFind.den;
  target.groundedEdit.num += source.groundedEdit.num;
  target.groundedEdit.den += source.groundedEdit.den;
  target.rework.num += source.rework.num;
  target.rework.den += source.rework.den;
  target.searchRepeat.num += source.searchRepeat.num;
  target.searchRepeat.den += source.searchRepeat.den;
  target.ruleFriction.num += source.ruleFriction.num;
  target.ruleFriction.den += source.ruleFriction.den;
  target.gateRepeat.num += source.gateRepeat.num;
  target.gateRepeat.den += source.gateRepeat.den;
  target.askQuestions += source.askQuestions;
  target.assistantTurns += source.assistantTurns;
  target.codeEdits += source.codeEdits;
}

export function emptyExtras(): ExtraCounts {
  return {
    rework: { num: 0, den: 0 },
    searchRepeat: { num: 0, den: 0 },
    ruleFriction: { num: 0, den: 0 },
    gateRepeat: { num: 0, den: 0 },
    fileFind: { num: 0, den: 0 },
    groundedEdit: { num: 0, den: 0 },
    askQuestions: 0,
    assistantTurns: 0,
    codeEdits: 0,
  };
}
