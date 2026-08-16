import { ScouterDb } from "./db.js";
import { computeSessionMetrics, type SessionMetrics } from "./metrics.js";
import {
  reportPeriod,
  segmentIntoPeriods,
  type Period,
  type PeriodReport,
  type SessionForPeriod,
} from "./periods.js";
import { summarizeWorkload, type WorkloadCounts } from "./worktype.js";

export interface AnalysisFilter {
  /** 프로젝트 경로 부분 일치. 지정하지 않으면 전체를 본다. */
  project?: string;
  execMode?: string;
}

export interface Analysis {
  forPeriods: SessionForPeriod[];
  sessions: SessionMetrics[];
  periods: Period[];
  latest: PeriodReport | null;
  /** 진행 중 구간을 뺀, 비교에 쓸 수 있는 마지막 구간의 보고 */
  latestClosed: PeriodReport | null;
  /**
   * 세션별 작업 유형 집계. 층화 실험이 쓴다.
   *
   * 유형이 아니라 집계를 담는다. 임계 변형마다 유형이 달라지는데, 유형을 여기서
   * 확정하면 변형을 돌릴 때마다 도구 호출을 다시 걸어야 한다.
   */
  workload: Map<string, WorkloadCounts>;
}

/** 사실 테이블에서 축을 다시 계산한다. 재파싱 없이 정의만 바꿔 돌릴 수 있어야 한다. */
export function analyze(db: ScouterDb, filter: AnalysisFilter = {}): Analysis {
  const metas = db.listSessions();
  const sessions: SessionMetrics[] = [];
  const forPeriods: SessionForPeriod[] = [];
  const workload = new Map<string, WorkloadCounts>();

  for (const meta of metas) {
    if (filter.project !== undefined && !meta.project.includes(filter.project))
      continue;
    if (filter.execMode !== undefined && meta.exec_mode !== filter.execMode)
      continue;
    const calls = db.toolCallsOf(meta.session_id);
    if (calls.length === 0) continue;
    const metrics = computeSessionMetrics(meta.session_id, calls);
    metrics.extras.assistantTurns = meta.assistant_turns;
    sessions.push(metrics);
    workload.set(meta.session_id, summarizeWorkload(calls));

    const eventCounts = db.eventCountsOf(meta.session_id);
    const artifactKinds = db.artifactKindsOf(meta.session_id);
    forPeriods.push({
      metrics,
      startedAt: meta.started_at,
      endedAt: meta.ended_at,
      events: {
        interrupt: eventCounts["interrupt"] ?? 0,
        queueMidflight: eventCounts["queue_enqueue_midflight"] ?? 0,
        userRejected: calls.filter((c) => c.denial_kind === "user-rejected")
          .length,
      },
      usage: db.usageOf(meta.session_id),
      reachedArtifact: artifactKinds.has("commit") || artifactKinds.has("pr"),
    });
  }

  const periods = segmentIntoPeriods(forPeriods);
  const latest =
    periods.length > 0 ? reportPeriod(periods, periods.length - 1) : null;

  let latestClosed: PeriodReport | null = null;
  for (let i = periods.length - 1; i >= 0; i -= 1) {
    if (periods[i]?.open === false) {
      latestClosed = reportPeriod(periods, i);
      break;
    }
  }

  return { sessions, forPeriods, periods, latest, latestClosed, workload };
}
