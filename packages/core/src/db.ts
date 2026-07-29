import { DatabaseSync } from "node:sqlite";

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
  subagent_tool_calls INTEGER,
  subagent_edit_files INTEGER,
  stdout_tail         TEXT,
  source_file         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, uuid)
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
`;

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
        this.db.prepare("DELETE FROM tool_call WHERE source_file = ?").run(path);
        this.db
          .prepare("DELETE FROM tool_result WHERE source_file = ?")
          .run(path);
        this.db.prepare("DELETE FROM artifact WHERE source_file = ?").run(path);
      }

      const upsertSession = this.db.prepare(`
        INSERT INTO session (session_id, project, git_branch, started_at, ended_at,
                             model, cc_version, entrypoint, exec_mode, skills_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          git_branch = COALESCE(excluded.git_branch, session.git_branch),
          started_at = MIN(COALESCE(session.started_at, excluded.started_at), excluded.started_at),
          ended_at   = MAX(COALESCE(session.ended_at, excluded.ended_at), excluded.ended_at),
          model      = COALESCE(excluded.model, session.model),
          cc_version = COALESCE(excluded.cc_version, session.cc_version),
          entrypoint = COALESCE(excluded.entrypoint, session.entrypoint),
          exec_mode  = excluded.exec_mode,
          skills_json = excluded.skills_json
      `);
      for (const s of facts.sessions.values()) {
        upsertSession.run(
          s.sessionId,
          s.project,
          s.gitBranch,
          s.startedAt,
          s.endedAt,
          s.model,
          s.ccVersion,
          s.entrypoint,
          s.execMode,
          s.skillsJson,
        );
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
          (session_id, uuid, total_lines, num_lines, start_line,
           subagent_tool_calls, subagent_edit_files, stdout_tail, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of facts.toolResults) {
        insertResult.run(
          r.sessionId,
          r.uuid,
          r.totalLines,
          r.numLines,
          r.startLine,
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

  /** 세션을 시작 시각순으로. 구간 분할기가 이 순서를 전제한다. */
  listSessions(): SessionMeta[] {
    return this.db
      .prepare(
        `SELECT session_id, project, git_branch, started_at, ended_at, exec_mode, skills_json
         FROM session WHERE started_at IS NOT NULL ORDER BY started_at`,
      )
      .all() as unknown as SessionMeta[];
  }

  /** 한 세션의 도구 호출을 순번순으로. 축3의 순서 판정이 이 순서에 의존한다. */
  toolCallsOf(sessionId: string): ToolCallRecord[] {
    return this.db
      .prepare(
        `SELECT c.seq, c.name, c.command, c.file_path, c.is_error, c.denial_kind, c.is_sidechain, c.agent_id,
                r.total_lines, r.num_lines, r.start_line,
                r.subagent_tool_calls, r.subagent_edit_files, r.stdout_tail
         FROM tool_call c
         LEFT JOIN tool_result r ON r.session_id = c.session_id AND r.uuid = c.uuid
         WHERE c.session_id = ? ORDER BY c.ts, c.source_file, c.seq`,
      )
      .all(sessionId) as unknown as ToolCallRecord[];
  }

  counts(): Record<string, number> {
    const tables = [
      "session",
      "tool_call",
      "tool_result",
      "artifact",
      "file_cursor",
    ];
    const out: Record<string, number> = {};
    for (const t of tables) {
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
  subagent_tool_calls: number | null;
  subagent_edit_files: number | null;
  stdout_tail: string | null;
}
