import { ScouterDb } from "./db.js";
import { computeSessionMetrics, type SessionMetrics } from "./metrics.js";
import {
  reportPeriod,
  segmentIntoPeriods,
  type Period,
  type PeriodReport,
  type SessionForPeriod,
} from "./periods.js";

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
}

/** 사실 테이블에서 축을 다시 계산한다. 재파싱 없이 정의만 바꿔 돌릴 수 있어야 한다. */
export function analyze(db: ScouterDb, filter: AnalysisFilter = {}): Analysis {
  const metas = db.listSessions();
  const sessions: SessionMetrics[] = [];
  const forPeriods: SessionForPeriod[] = [];

  for (const meta of metas) {
    if (filter.project !== undefined && !meta.project.includes(filter.project))
      continue;
    if (filter.execMode !== undefined && meta.exec_mode !== filter.execMode)
      continue;
    const calls = db.toolCallsOf(meta.session_id);
    if (calls.length === 0) continue;
    const metrics = computeSessionMetrics(meta.session_id, calls);
    sessions.push(metrics);
    forPeriods.push({
      metrics,
      startedAt: meta.started_at,
      endedAt: meta.ended_at,
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

  return { sessions, forPeriods, periods, latest, latestClosed };
}
