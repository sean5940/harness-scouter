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
  project: string;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  ccVersion: string | null;
  entrypoint: string | null;
  execMode: ExecMode;
  skillsJson: string;
}

/**
 * 도구 호출 한 건. `seq`는 세션 내 전역 순번이며 축3의 순서 판정에 쓴다.
 * 타임스탬프는 같은 초에 여러 건이 찍혀 순서를 못 가리므로 seq가 필요하다.
 */
export interface ToolCallRow {
  sessionId: string;
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
  uuid: string;
  totalLines: number | null;
  numLines: number | null;
  startLine: number | null;
  /** subagent 결과의 내부 도구 호출 합계. 커버리지 배지에 쓴다 (설계 9절). */
  subagentToolCalls: number | null;
  subagentEditFiles: number | null;
}

export interface ArtifactRow {
  sessionId: string;
  kind: "pr" | "commit";
  ref: string;
  ts: string | null;
}

/** 세션 하나에서 뽑아낸, 축 계산에 필요한 이벤트 집합. */
export interface SessionFacts {
  session: SessionRow;
  toolCalls: ToolCallRow[];
  toolResults: Map<string, ToolResultRow>;
}
