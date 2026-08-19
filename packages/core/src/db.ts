import { DatabaseSync } from "node:sqlite";

import { isSyntheticWorkspace } from "./definitions.js";
import type { ExtractedFacts } from "./extract.js";
import type { FileCursor } from "./parser.js";

/**
 * 사실 테이블. 해석을 담지 않는다 (설계 4.2).
 *
 * 축 점수를 여기 넣지 않는 이유는 지표 정의가 계속 바뀌기 때문이다. 정의를 고칠 때마다
 * 900MB를 재파싱해야 하면 반복 주기가 무너진다. 이 테이블은 파싱 결과만 담고,
 * 축은 매번 여기서 다시 계산한다.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_cursor (
  path       TEXT PRIMARY KEY,
  mtime_ms   REAL NOT NULL,
  byte_offset INTEGER NOT NULL,
  parsed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  -- 트랜스크립트가 적어준 작업 경로. project는 디렉토리 이름을 되돌린 추측이라
  -- 슬래시와 점을 구분하지 못하는데, 이 값은 원본 그대로다.
  cwd        TEXT,
  git_branch TEXT,
  started_at TEXT,
  ended_at   TEXT,
  model      TEXT,
  cc_version TEXT,
  entrypoint TEXT,
  exec_mode  TEXT NOT NULL,
  skills_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_call (
  session_id  TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  ts          TEXT,
  is_error    INTEGER,
  denial_kind TEXT,
  command     TEXT,
  file_path   TEXT,
  read_offset INTEGER,
  read_limit  INTEGER,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  agent_id    TEXT,
  source_file TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, uuid)
);

CREATE TABLE IF NOT EXISTS tool_result (
  session_id          TEXT NOT NULL,
  uuid                TEXT NOT NULL,
  total_lines         INTEGER,
  num_lines           INTEGER,
  start_line          INTEGER,
  edit_type           TEXT,
  subagent_tool_calls INTEGER,
  subagent_edit_files INTEGER,
  stdout_tail         TEXT,
  source_file         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, uuid)
);

CREATE TABLE IF NOT EXISTS session_turn (
  session_id  TEXT NOT NULL,
  source_file TEXT NOT NULL,
  turns       INTEGER NOT NULL,
  PRIMARY KEY (session_id, source_file)
);

CREATE TABLE IF NOT EXISTS usage (
  session_id     TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  input          INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  ts             TEXT,
  source_file    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, request_id)
);

CREATE TABLE IF NOT EXISTS session_event (
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ts          TEXT,
  source_file TEXT NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact (
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  ts         TEXT,
  source_file TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, kind, ref)
);

CREATE INDEX IF NOT EXISTS idx_tool_call_session ON tool_call(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_started ON session(started_at);
CREATE INDEX IF NOT EXISTS idx_session_event ON session_event(session_id, kind);
`;

/** 트랜스크립트에서 파생된 사실 테이블 전부. 개수 집계와 재빌드가 같은 목록을 쓴다. */
const DATA_TABLES = [
  "session",
  "tool_call",
  "tool_result",
  "artifact",
  "session_event",
  "session_turn",
  "usage",
  "file_cursor",
] as const;

export interface ScanStats {
  filesScanned: number;
  filesChanged: number;
  entriesParsed: number;
  malformedLines: number;
  fullReparses: number;
}

export class ScouterDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * 이미 만들어진 DB에 뒤늦게 생긴 열을 붙인다.
   *
   * `CREATE TABLE IF NOT EXISTS`는 표가 있으면 통째로 건너뛰므로 열 추가가 반영되지
   * 않는다. 없는 열을 참조하는 쿼리는 그때 처음 죽는데, 스캔 훅이 출력을 버리는 자리라
   * 조용히 실패한다.
   */
  private migrate(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('session')")
      .all() as unknown as Array<{ name: string }>;
    const have = new Set(columns.map((c) => c.name));
    if (!have.has("cwd")) {
      this.db.exec("ALTER TABLE session ADD COLUMN cwd TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  getCursor(path: string): FileCursor | null {
    const row = this.db
      .prepare(
        "SELECT path, mtime_ms, byte_offset FROM file_cursor WHERE path = ?",
      )
      .get(path) as
      { path: string; mtime_ms: number; byte_offset: number } | undefined;
    if (row === undefined) return null;
    return {
      path: row.path,
      mtimeMs: row.mtime_ms,
      byteOffset: row.byte_offset,
    };
  }

  /**
   * 파일 하나의 추출 결과를 반영한다.
   *
   * 커서 갱신과 행 적재를 한 트랜잭션에 묶는다. 중간에 죽으면 커서만 앞으로 가고
   * 데이터는 안 들어간 상태가 되는데, 그러면 그 구간을 영영 다시 안 읽는다.
   */
  applyFile(
    path: string,
    cursor: { mtimeMs: number; byteOffset: number },
    facts: ExtractedFacts,
    reparsedFromStart: boolean,
  ): void {
    this.db.exec("BEGIN");
    try {
      if (reparsedFromStart) {
        // 한 세션의 기록이 메인 파일과 subagent 파일 여러 개에 흩어져 있다(평균 3.2개).
        // 세션 단위로 지우면 재파싱하지 않은 파일의 행까지 날아가고 다시 채워지지 않는다.
        this.db
          .prepare("DELETE FROM tool_call WHERE source_file = ?")
          .run(path);
        this.db
          .prepare("DELETE FROM tool_result WHERE source_file = ?")
          .run(path);
        this.db.prepare("DELETE FROM artifact WHERE source_file = ?").run(path);
        this.db
          .prepare("DELETE FROM session_event WHERE source_file = ?")
          .run(path);
        this.db.prepare("DELETE FROM usage WHERE source_file = ?").run(path);
        this.db
          .prepare("DELETE FROM session_turn WHERE source_file = ?")
          .run(path);
      }

      // 같은 세션에 대한 upsert가 파일 수만큼, 증분 회차마다 일어난다. 그중 상당수는
      // 타임스탬프도 entrypoint도 스킬도 없는 조각이라, 조각이 이긴 필드는 값을 잃는다.
      // 특히 MIN/MAX 스칼라는 인자 하나가 NULL이면 NULL을 내므로 started_at이 통째로
      // 지워졌고, 그 세션은 listSessions()의 started_at IS NOT NULL에서 탈락해
      // 코퍼스에서 사라졌다. 2026-08-19 실측으로 111개 중 32개가 이렇게 빠져 있었다.
      // 하필 파일을 많이 걸친 큰 세션이 걸린다(결손 평균 12.3파일 대 정상 2.4).
      const upsertSession = this.db.prepare(`
        INSERT INTO session (session_id, project, cwd, git_branch, started_at, ended_at,
                             model, cc_version, entrypoint, exec_mode, skills_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          cwd        = COALESCE(excluded.cwd, session.cwd),
          git_branch = COALESCE(excluded.git_branch, session.git_branch),
          started_at = CASE
            WHEN session.started_at IS NULL THEN excluded.started_at
            WHEN excluded.started_at IS NULL THEN session.started_at
            ELSE MIN(session.started_at, excluded.started_at) END,
          ended_at = CASE
            WHEN session.ended_at IS NULL THEN excluded.ended_at
            WHEN excluded.ended_at IS NULL THEN session.ended_at
            ELSE MAX(session.ended_at, excluded.ended_at) END,
          model      = COALESCE(excluded.model, session.model),
          cc_version = COALESCE(excluded.cc_version, session.cc_version),
          entrypoint = COALESCE(excluded.entrypoint, session.entrypoint),
          exec_mode  = CASE WHEN excluded.exec_mode = 'unknown'
                            THEN session.exec_mode ELSE excluded.exec_mode END,
          skills_json = (
            SELECT json_group_array(value) FROM (
              SELECT value FROM json_each(
                CASE WHEN json_valid(session.skills_json)
                     THEN session.skills_json ELSE '[]' END)
              UNION
              SELECT value FROM json_each(
                CASE WHEN json_valid(excluded.skills_json)
                     THEN excluded.skills_json ELSE '[]' END)
              ORDER BY value
            )
          )
      `);
      for (const s of facts.sessions.values()) {
        upsertSession.run(
          s.sessionId,
          s.project,
          s.cwd,
          s.gitBranch,
          s.startedAt,
          s.endedAt,
          s.model,
          s.ccVersion,
          s.entrypoint,
          s.execMode,
          s.skillsJson,
        );
        // 턴은 파일 단위 행으로 둔다. 세션 스칼라에 누적하면 재파싱마다 늘어난다.
        // 증분 파싱은 새로 읽은 줄만 더하고, 전체 재파싱은 위에서 이 파일 행을 지운 뒤 다시 넣는다.
        // 덮어쓰기로 두면 증분 회차마다 앞서 읽은 줄의 턴이 사라진다.
        this.db
          .prepare(
            `INSERT INTO session_turn (session_id, source_file, turns) VALUES (?, ?, ?)
             ON CONFLICT(session_id, source_file) DO UPDATE SET
               turns = session_turn.turns + excluded.turns`,
          )
          .run(s.sessionId, path, s.assistantTurns);
      }

      const insertCall = this.db.prepare(`
        INSERT OR REPLACE INTO tool_call
          (session_id, uuid, seq, name, ts, is_error, denial_kind, command, file_path, read_offset, read_limit, is_sidechain, agent_id, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of facts.toolCalls) {
        insertCall.run(
          c.sessionId,
          c.uuid,
          c.seq,
          c.name,
          c.ts,
          c.isError,
          c.denialKind,
          c.command,
          c.filePath,
          c.readOffset,
          c.readLimit,
          c.isSidechain,
          c.agentId,
          path,
        );
      }

      const insertResult = this.db.prepare(`
        INSERT OR REPLACE INTO tool_result
          (session_id, uuid, total_lines, num_lines, start_line, edit_type,
           subagent_tool_calls, subagent_edit_files, stdout_tail, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of facts.toolResults) {
        insertResult.run(
          r.sessionId,
          r.uuid,
          r.totalLines,
          r.numLines,
          r.startLine,
          r.editType,
          r.subagentToolCalls,
          r.subagentEditFiles,
          facts.stdoutTails.get(r.uuid) ?? null,
          path,
        );
      }

      const insertArtifact = this.db.prepare(
        "INSERT OR REPLACE INTO artifact (session_id, kind, ref, ts, source_file) VALUES (?, ?, ?, ?, ?)",
      );
      for (const a of facts.artifacts) {
        insertArtifact.run(a.sessionId, a.kind, a.ref, a.ts, path);
      }

      const insertEvent = this.db.prepare(
        "INSERT INTO session_event (session_id, kind, ts, source_file, seq) VALUES (?, ?, ?, ?, ?)",
      );
      facts.sessionEvents.forEach((e, index) => {
        insertEvent.run(e.sessionId, e.kind, e.ts, path, index);
      });

      // requestId가 이미 있으면 무시한다. 같은 응답이 여러 줄로 오기 때문이다.
      const insertUsage = this.db.prepare(
        `INSERT OR IGNORE INTO usage
           (session_id, request_id, input, output, cache_read, cache_creation, ts, source_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, request_id) DO UPDATE SET
           output = MAX(usage.output, excluded.output),
           input = MAX(usage.input, excluded.input),
           cache_read = MAX(usage.cache_read, excluded.cache_read),
           cache_creation = MAX(usage.cache_creation, excluded.cache_creation)`,
      );
      for (const u of facts.usages) {
        insertUsage.run(
          u.sessionId,
          u.requestId,
          u.input,
          u.output,
          u.cacheRead,
          u.cacheCreation,
          u.ts,
          path,
        );
      }

      this.db
        .prepare(
          `INSERT INTO file_cursor (path, mtime_ms, byte_offset, parsed_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(path) DO UPDATE SET
             mtime_ms = excluded.mtime_ms,
             byte_offset = excluded.byte_offset,
             parsed_at = excluded.parsed_at`,
        )
        .run(path, cursor.mtimeMs, cursor.byteOffset);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 세션을 시작 시각순으로. 구간 분할기가 이 순서를 전제한다.
   *
   * 임시 워크스페이스 세션은 뺀다. 몇 개를 뺐는지는 excludedSyntheticCount()가 낸다.
   * 조용히 빼면 코퍼스가 줄어든 것이 규칙 때문인지 일을 덜 한 것인지 못 가린다.
   */
  listSessions(): SessionMeta[] {
    return this.allSessions().filter((s) => !isSyntheticWorkspace(s.project));
  }

  /** 코퍼스에서 뺀 임시 워크스페이스 세션 수. */
  excludedSyntheticCount(): number {
    return this.allSessions().filter((s) => isSyntheticWorkspace(s.project))
      .length;
  }

  private allSessions(): SessionMeta[] {
    return this.db
      .prepare(
        `SELECT session_id, COALESCE(cwd, project) AS project,
                git_branch, started_at, ended_at, exec_mode, skills_json
         , COALESCE(
             (SELECT SUM(turns) FROM session_turn t WHERE t.session_id = session.session_id),
             0
           ) AS assistant_turns
         FROM session WHERE started_at IS NOT NULL ORDER BY started_at`,
      )
      .all() as unknown as SessionMeta[];
  }

  /** 한 세션의 도구 호출을 순번순으로. 축3의 순서 판정이 이 순서에 의존한다. */
  toolCallsOf(sessionId: string): ToolCallRecord[] {
    return this.db
      .prepare(
        `SELECT c.seq, c.name, c.command, c.file_path, c.is_error, c.denial_kind, c.is_sidechain, c.agent_id,
                r.total_lines, r.num_lines, r.start_line, r.edit_type,
                r.subagent_tool_calls, r.subagent_edit_files, r.stdout_tail
         FROM tool_call c
         LEFT JOIN tool_result r ON r.session_id = c.session_id AND r.uuid = c.uuid
         WHERE c.session_id = ? ORDER BY c.ts, c.source_file, c.seq`,
      )
      .all(sessionId) as unknown as ToolCallRecord[];
  }

  /** 세션별 이벤트 건수. 능력치 합성이 쓴다. */
  eventCountsOf(sessionId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT kind, COUNT(*) AS n FROM session_event WHERE session_id = ? GROUP BY kind",
      )
      .all(sessionId) as unknown as Array<{ kind: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.kind] = row.n;
    return out;
  }

  /** 세션에 연결된 PR 번호. 타당성 검증의 표본이 된다. */
  prOutcomeRefs(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT ref FROM artifact WHERE kind = 'pr'")
        .all() as unknown as Array<{ ref: string }>
    ).map((r) => r.ref);
  }

  /** 앞자리만으로 세션을 찾는다. 진단 출력이 8자만 보여주기 때문이다. */
  resolveSessionId(prefix: string): string | null {
    const rows = this.db
      .prepare("SELECT session_id FROM session WHERE session_id LIKE ? LIMIT 2")
      .all(`${prefix}%`) as unknown as Array<{ session_id: string }>;
    return rows.length === 1 ? (rows[0]?.session_id ?? null) : null;
  }

  /** 세션별 토큰 사용량 합계. 토큰 효율이 쓴다. */
  usageOf(sessionId: string): {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    requests: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
                COALESCE(SUM(cache_read),0) AS cacheRead,
                COALESCE(SUM(cache_creation),0) AS cacheCreation,
                COUNT(*) AS requests
         FROM usage WHERE session_id = ?`,
      )
      .get(sessionId) as unknown as {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      requests: number;
    };
    return row;
  }

  /** 세션별 산출물 종류. 완수력이 쓴다. */
  artifactKindsOf(sessionId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT kind FROM artifact WHERE session_id = ?")
      .all(sessionId) as unknown as Array<{ kind: string }>;
    return new Set(rows.map((r) => r.kind));
  }

  /**
   * 사실 테이블을 전부 비운다. 커서까지 지우므로 다음 스캔이 전 파일을 처음부터 읽는다.
   *
   * 추출·병합 규칙을 고쳤을 때 쓴다. 규칙만 고치면 이미 들어간 행은 낡은 규칙으로 만든
   * 값 그대로 남고, 커서가 앞서 있어 그 파일을 다시 읽지도 않는다. 이 테이블은 전부
   * 트랜스크립트에서 파생된 것이라 지워도 잃는 원본이 없다.
   */
  reset(): void {
    this.db.exec("BEGIN");
    try {
      for (const t of DATA_TABLES) this.db.exec(`DELETE FROM ${t}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of DATA_TABLES) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as {
        n: number;
      };
      out[t] = row.n;
    }
    return out;
  }
}

export interface SessionMeta {
  session_id: string;
  assistant_turns: number;
  project: string;
  git_branch: string | null;
  started_at: string;
  ended_at: string | null;
  exec_mode: string;
  skills_json: string;
}

export interface ToolCallRecord {
  seq: number;
  name: string;
  is_sidechain: number;
  agent_id: string | null;
  command: string | null;
  file_path: string | null;
  is_error: number | null;
  denial_kind: string | null;
  total_lines: number | null;
  num_lines: number | null;
  start_line: number | null;
  edit_type: string | null;
  subagent_tool_calls: number | null;
  subagent_edit_files: number | null;
  stdout_tail: string | null;
}
