/** JSONL 한 줄을 파싱한 결과. 모르는 필드는 버리고 필요한 것만 남긴다. */
export interface RawEntry {
  type?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  attributionSkill?: string;
  requestId?: string;
  agentId?: string;
  toolDenialKind?: string;
  promptSource?: string;
  message?: RawMessage;
  toolUseResult?: unknown;
  trackingPath?: string;
  prNumber?: number;
  operation?: string;
}

export interface RawMessage {
  role?: string;
  model?: string;
  stop_reason?: string;
  content?: unknown;
  usage?: RawUsage;
}

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 실행 모드. 층화 1차 기준 (설계 3.1). */
export type ExecMode = "interactive" | "headless" | "unknown";

export interface SessionRow {
  sessionId: string;
  /** 디렉토리 이름을 되돌린 추측. `/`와 `.`이 똑같이 `-`로 인코딩돼 정확하지 않다. */
  project: string;
  /** 트랜스크립트가 적어준 작업 경로 원본. 있으면 project 대신 이걸 쓴다. */
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  ccVersion: string | null;
  entrypoint: string | null;
  execMode: ExecMode;
  skillsJson: string;
  /** assistant 턴 수. 개입 빈도를 턴당으로 정규화할 때 쓴다. */
  assistantTurns: number;
}

/**
 * 도구 호출 한 건. `seq`는 세션 내 전역 순번이며 축3의 순서 판정에 쓴다.
 * 타임스탬프는 같은 초에 여러 건이 찍혀 순서를 못 가리므로 seq가 필요하다.
 */
export interface ToolCallRow {
  sessionId: string;
  /** 이 행이 어느 트랜스크립트 파일에서 왔는지. 재파싱 시 그 파일 몫만 지우는 데 쓴다. */
  sourceFile: string;
  uuid: string;
  seq: number;
  name: string;
  ts: string | null;
  isError: number | null;
  denialKind: string | null;
  /** Bash면 command, Read/Edit/Write면 file_path 등 축 계산에 쓰는 입력만 보존한다. */
  command: string | null;
  filePath: string | null;
  readOffset: number | null;
  readLimit: number | null;
  /** subagent 트랜스크립트에서 온 호출인지. 부모 세션에 합쳐 세되 구분은 남긴다. */
  isSidechain: number;
  /** 어느 에이전트의 컨텍스트인지. 메인은 null. 컨텍스트별 상태를 분리하는 데 쓴다. */
  agentId: string | null;
}

/** Read 결과의 크기 정보. 축1 no-op 가드에 필요하다. */
export interface ToolResultRow {
  sessionId: string;
  sourceFile: string;
  uuid: string;
  totalLines: number | null;
  numLines: number | null;
  startLine: number | null;
  /**
   * 편집 결과 종류. create·update·file_unchanged.
   * 새로 만든 파일은 읽을 것이 없으므로 근거 확보율 분모에서 빼는 데 쓴다.
   */
  editType: string | null;
  /** subagent 결과의 내부 도구 호출 합계. 커버리지 배지에 쓴다 (설계 9절). */
  subagentToolCalls: number | null;
  subagentEditFiles: number | null;
}

/**
 * API 응답 하나의 토큰 사용량.
 *
 * 한 응답이 콘텐츠 블록마다 같은 usage를 싣고 오므로 requestId로 중복을 제거해야 한다.
 * 안 하면 토큰이 2.7배로 부풀려진다(실측 5,795행 → 고유 2,147).
 */
export interface UsageRow {
  sessionId: string;
  sourceFile: string;
  requestId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  ts: string | null;
}

/** 축이 아니라 능력치 합성에 쓰는 세션 단위 이벤트. */
export interface SessionEventRow {
  sessionId: string;
  sourceFile: string;
  kind:
    | "interrupt"
    | "queue_enqueue"
    | "queue_enqueue_midflight"
    | "queue_removed"
    | "queue_remove";
  ts: string | null;
}

export interface ArtifactRow {
  sessionId: string;
  sourceFile: string;
  /**
   * `commit` 은 호출 시점의 내부 키라 git 과 못 잇는다. `commit-sha` 는 결과에서 뽑은
   * 실제 해시로, 타당성 검증을 사람 라벨이 아니라 결과로 하려면 이쪽이 필요하다.
   */
  kind: "pr" | "commit" | "commit-sha";
  ref: string;
  ts: string | null;
}

/** 세션 하나에서 뽑아낸, 축 계산에 필요한 이벤트 집합. */
export interface SessionFacts {
  session: SessionRow;
  toolCalls: ToolCallRow[];
  toolResults: Map<string, ToolResultRow>;
}
