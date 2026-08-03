import type { StatComponent, StatEntry, StatKey } from "./stats.js";

/**
 * 능력치별 성장 가이드.
 *
 * 점수만으로는 무엇을 고쳐야 하는지 알 수 없다. 그렇다고 "80점이면 좋음" 같은 절대
 * 임계를 만들면 근거 없는 숫자가 된다. 좋은 세션 라벨이 없어서 외부 기준을 세울 수 없기
 * 때문이다(설계 5.5).
 *
 * 그래서 목표를 **개인 최고 기록**으로 잡는다. 한 번 찍어본 값은 이 하네스로 도달
 * 가능하다는 것이 데이터로 증명된 목표이고, 격차를 만든 구성요소가 곧 할 일이다.
 */

export interface ComponentCriterion {
  /** 무엇을 세는가. 분자와 분모를 사람 말로. */
  measures: string;
  /** 이 값이 낮으면 실무에서 무엇이 나빠지는가. */
  whyItMatters: string;
  /** 올리는 구체 행동. */
  actions: string[];
  /**
   * 점수는 오르는데 품질은 안 오르는 처방.
   * 적대적 검토가 반복해서 보여준 것은 가장 싼 개선책이 대개 조작이라는 것이다.
   */
  antipatterns: string[];
}

/** 구성요소 라벨을 키로 쓴다. 스탯 구성이 바뀌어도 가이드가 따라온다. */
export const COMPONENT_CRITERIA: Record<string, ComponentCriterion> = {
  "인덱스 우선 탐색": {
    measures:
      "전체 탐색 중 qmd·graphify로 간 비율. Bash 재귀검색과 Grep·Glob은 전수 스캔으로 센다.",
    whyItMatters:
      "전수 스캔은 결과가 많고 관련도 순서가 없어 읽는 토큰이 늘고, 찾은 뒤에도 어느 것이 맞는지 다시 골라야 한다.",
    actions: [
      "탐색 위임 brief에 `qmd query`·`graphify query`를 호출 순서까지 명시한다. subagent는 지시하지 않은 도구를 쓰지 않는다.",
      "검색 게이트 훅의 matcher가 `find … -name`과 `-iname`을 잡는지 확인한다. `grep -r`·`rg`만 잡고 있으면 우회가 그대로 통과한다.",
      "스킬 본문 탐색 단계에 대체 경로를 명령형으로 적는다. 금지만 있고 대안이 없는 규칙은 재발률이 높다.",
    ],
    antipatterns: [
      "Bash 검색을 Grep 도구로만 바꾸기. 조작 시뮬레이션에서 이 한 수로 점수가 71p 올랐다. 채널만 바뀌고 하는 일은 전수 스캔 그대로다.",
      "qmd를 의미 없이 여러 번 호출해 분모를 키우기.",
    ],
  },
  "검색 한 번에 찾기": {
    measures: "재귀검색 중 같은 검색어를 세션 안에서 다시 찾은 비율의 역수.",
    whyItMatters:
      "같은 것을 또 찾는다는 것은 첫 검색의 범위나 패턴이 틀렸다는 뜻이다.",
    actions: [
      "검색 전에 대상 디렉토리를 좁힌다. 저장소 루트에서 시작하면 결과가 섞여 다시 찾게 된다.",
      "찾는 것이 심볼이면 텍스트 검색 대신 graphify로 호출관계를 본다.",
    ],
    antipatterns: ["검색어를 매번 조금씩 바꿔 중복 판정을 피하기."],
  },
  "커밋 전 검증 신선도": {
    measures: "코드를 고친 커밋 중, 마지막 편집 **이후에** 검증이 돈 비율.",
    whyItMatters:
      "검증을 돌린 뒤 또 고치고 커밋하면 커밋된 최종 상태는 한 번도 통과한 적이 없다. 검증 횟수를 늘려도 이 구멍은 안 닫힌다.",
    actions: [
      "게이트를 커밋 시점으로 옮긴다. `PreToolUse:Bash`에서 `git commit`을 잡아 마지막 편집 이후 verifier가 없으면 차단한다.",
      "차단 메시지에 대안 경로를 문장으로 넣는다. 금지만 통보하면 재발하고, 대체 명령을 주면 재발이 줄었다.",
      "리뷰 지적을 반영한 뒤 재검증하는 단계를 리뷰 스킬 종료 절차에 넣는다.",
    ],
    antipatterns: [
      'CLAUDE.md에 "항상 tsc를 돌려라"를 넣기. 신선도는 오르고 공회전이 같이 튄다.',
      "`tsc && eslint && test`를 훅으로 강제하기. 행동은 그대로인데 점수만 오른다.",
    ],
  },
  "검증 공회전 없음": {
    measures: "verifier 호출 중, 편집 없이 같은 종류를 다시 돌린 것의 역수.",
    whyItMatters:
      "실패를 못 읽어서 같은 검증을 반복하는 경우가 많다. 검증 호출의 상당수가 파이프로 exit code를 삼킨다.",
    actions: [
      "스킬의 검증 스텝을 개별 나열 대신 `tsc && eslint && prettier --check` 단일 명령으로 못박는다.",
      'verifier에 `; echo "EXIT=$?"`를 붙이도록 훅에서 리라이트한다. 조작 방향이 없는 드문 안전한 훅이다. 점수는 stdout 파싱으로 매기므로 exit code 노출이 점수를 올리지 않는다.',
    ],
    antipatterns: ["검증 횟수 상한을 훅으로 걸기. 수정 후 재검증까지 막힌다."],
  },
  "산출물 도달": {
    measures: "코드를 고친 세션 중 커밋이나 PR까지 간 비율.",
    whyItMatters: "고쳐놓고 안 남기면 다음 세션이 같은 자리에서 다시 시작한다.",
    actions: [
      "세션 종료 전 커밋 여부를 확인하는 단계를 워크플로 끝에 둔다.",
      "worktree 세션은 브랜치를 push까지 해야 다른 세션에서 보인다.",
    ],
    antipatterns: ["의미 없는 빈 커밋으로 도달률만 채우기."],
  },
  "재작업 없음": {
    measures:
      "편집 중, 검증이나 커밋을 넘긴 뒤 같은 파일을 다시 고친 것의 역수.",
    whyItMatters:
      "체크포인트를 넘겨 되돌아온다는 것은 그 시점의 판단이 틀렸다는 뜻이다.",
    actions: [
      "편집 전에 대상 범위를 먼저 확정한다. 같은 패스 안의 여러 hunk 편집은 재작업으로 세지 않으므로, 한 번에 몰아 고치는 쪽이 유리하다.",
      "재작업이 몰리는 파일을 진단에서 확인하고 그 파일의 계획 단계를 보강한다.",
    ],
    antipatterns: [
      "검증을 아예 안 해서 체크포인트를 없애기. 분모가 사라져 점수가 오른다.",
    ],
  },
  "사람 개입 없음": {
    measures:
      "assistant 턴 100회당 개입 건수. 실행 중단, 도구 호출 중 큐 입력, 도구 거부를 합쳐 센다.",
    whyItMatters:
      "개입이 잦다는 것은 방향을 잘못 잡고 달렸거나 확인 없이 진행했다는 뜻이다. 도구 체인을 안 끊는 큐 입력이 중단보다 훨씬 많다.",
    actions: [
      "착수 전 계획을 짧게 제시해 방향을 맞춘다. 개입 대부분은 중간에 방향을 트는 것이다.",
      "되돌리기 어려운 작업 전에 확인한다. 도구 거부는 그 확인을 안 했다는 신호다.",
    ],
    antipatterns: [
      "질문을 아예 안 해서 개입을 줄이기. 확인이 필요한 자리를 건너뛰면 재작업으로 돌아온다.",
      "감독을 없애는 방향. 이 값이 만점이라는 것은 사람이 지켜보지 않았다는 뜻일 수도 있다.",
    ],
  },
  "계측 채널 준수": {
    measures:
      "파일 접근 중 Read·Edit·Write로 간 비율. `cat`·`sed -n` 읽기와 `sed -i`·heredoc 쓰기는 계측 밖이다.",
    whyItMatters:
      "bash로 파일을 고치면 다른 능력치도 함께 실명한다. 읽기 범위도 재작업도 검증 신선도도 그 편집을 못 본다.",
    actions: [
      "소스 읽기를 Read로 되돌린다. 프로젝트 규칙에 이미 있는 항목이므로 규칙이 아니라 집행이 빠진 것이다.",
      "파일 쓰기를 Edit·Write로 되돌린다. `python3 - <<EOF`로 파일을 여는 스크립트가 주 대상이다.",
      "분석용 heredoc과 파일 쓰기용 heredoc을 구분한다. stdout만 내는 것은 우회가 아니다.",
    ],
    antipatterns: [
      "예외 목록을 넓혀 점수 올리기. 측정값이 행동이 아니라 목록 편집에 반응하는 순간 축이 죽는다.",
      "명령을 `&&`로 이어붙여 호출 수 줄이기. 검증 신선도와 공회전 판정이 동시에 망가진다.",
      "`2>/tmp/x.log`를 덧붙여 임시 경로 예외로 빠져나가기.",
    ],
  },
  "규칙 위반 시도 없음": {
    measures: "도구 호출 중 훅이나 권한에 막히지 않은 비율.",
    whyItMatters:
      "차단이 잦다는 것은 규칙을 모르거나 규칙이 실제 흐름과 안 맞는다는 뜻이다.",
    actions: [
      "같은 게이트에 반복해서 걸리면 규칙이 아니라 스킬 본문을 고친다. 진단에서 재발 게이트를 확인한다.",
      "차단 메시지가 대안 경로를 주는지 확인한다. 금지만 통보하는 게이트가 재발률이 높다.",
    ],
    antipatterns: [
      "훅을 지워서 차단을 없애기. 방어를 없앨수록 좋아 보이는 값은 지표가 아니다.",
    ],
  },
  "읽기 범위 규율": {
    measures:
      "200줄 넘는 파일 읽기 중 범위를 지정한 비율. 파일 전체를 덮는 지정은 인정하지 않는다.",
    whyItMatters:
      "큰 파일을 통째로 읽으면 컨텍스트가 차고, 그 뒤 모든 턴이 그 무게를 계속 나른다.",
    actions: [
      "위임 brief 필수 요소에 읽을 라인 범위를 넣는다. subagent는 범위를 안 주면 통째로 연다.",
      "재읽기 상위 파일이 곧 스킬 진입 시 미리 넣었어야 할 컨텍스트 목록이다.",
      "200줄 넘는 레퍼런스 문서는 규칙을 고치지 말고 파일을 쪼갠다.",
    ],
    antipatterns: [
      "`limit: 2000`을 훅으로 주입하기. Read 기본 상한과 같아 아무것도 좁히지 않는데 부분읽기로 집계된다.",
      "chunk 순회로 잘게 쪼개기. 읽은 것 기억하기가 대신 떨어진다.",
    ],
  },
  "읽은 것 기억하기": {
    measures:
      "읽기 중 같은 파일을 다시 읽지 않은 비율. 편집 뒤 재확인은 정당하므로 뺀다.",
    whyItMatters:
      "같은 파일을 다시 연다는 것은 첫 읽기에서 필요한 것을 못 챙겼다는 뜻이다.",
    actions: [
      "`PostToolUse:Edit` 훅이 편집한 hunk의 전후 몇 줄을 돌려주게 하면 편집 후 재확인이 불필요해진다.",
      "같은 파일을 세 번 이상 연 세션의 스킬을 본다. 특정 스킬에 몰리면 그 스킬의 단계 순서가 잘못된 것이다.",
    ],
    antipatterns: [
      "파일을 통째로 읽어 재방문을 없애기. 읽기 범위 규율이 대신 떨어진다.",
    ],
  },
  "응답 간결성": {
    measures:
      "읽기·편집 호출 한 번당 생성한 출력 토큰. 500토큰이 만점, 4,000토큰이 0점이다. 분모는 Read·Edit·Write 계열만 세고 Bash·검색은 빠진다.",
    whyItMatters:
      "같은 일을 하면서 길게 생성하면 비용과 지연이 함께 늘고, 읽는 사람의 부담도 커진다.",
    actions: [
      "긴 설명 대신 도구를 먼저 부른다. 확인할 수 있는 것을 서술로 대신하면 길어진다.",
      "생각을 정리하는 서술과 사용자에게 필요한 보고를 구분한다.",
    ],
    antipatterns: [
      "도구를 잘게 쪼개 호출해 분모를 키우기. 검증 공회전과 계측 채널이 대신 나빠진다.",
    ],
  },
  "컨텍스트 경량성": {
    measures:
      "요청 한 번마다 실려 가는 캐시 컨텍스트 크기. 100K가 만점, 400K가 0점이다.",
    whyItMatters:
      "컨텍스트는 매 턴 다시 실려 간다. 캐시 읽기가 생성 토큰의 100배를 넘는 규모라 여기가 비용의 대부분이다.",
    actions: [
      "탐색 결과 원문을 main에 쌓지 말고 subagent에 위임해 결론만 받는다.",
      "긴 세션을 작업 단위로 끊는다. 한 세션이 길어질수록 매 턴 나르는 무게가 커진다.",
      "큰 파일을 범위 지정으로 읽는다. 읽기 범위 규율과 같은 레버다.",
    ],
    antipatterns: [
      "필요한 컨텍스트까지 빼서 가볍게 만들기. 재작업과 읽기 왕복이 대신 오른다.",
    ],
  },
};

export interface GrowthAdvice {
  stat: StatKey;
  label: string;
  score: number | null;
  best: number | null;
  /** 개인 최고까지 남은 점수. 도달 가능성이 증명된 목표다. */
  gapToBest: number | null;
  /** 격차를 만든 구성요소. 가장 낮은 것을 고른다. */
  bottleneck: StatComponent | null;
  criterion: ComponentCriterion | null;
}

/**
 * 스탯 하나의 병목과 처방을 찾는다.
 *
 * 목표를 개인 최고로 잡는 이유는 그 값이 이 하네스로 도달 가능하다는 것이 이미
 * 관측됐기 때문이다. 임의의 절대 임계는 근거가 없고, 남과의 비교는 표본이 없다.
 */
export function adviseStat(stat: StatEntry): GrowthAdvice {
  let bottleneck: StatComponent | null = null;
  for (const component of stat.components) {
    if (component.value === null) continue;
    if (bottleneck === null || component.value < (bottleneck.value ?? 1)) {
      bottleneck = component;
    }
  }

  return {
    stat: stat.key,
    label: stat.label,
    score: stat.score,
    best: stat.best,
    gapToBest:
      stat.score === null || stat.best === null
        ? null
        : Math.max(0, stat.best - stat.score),
    bottleneck,
    criterion:
      bottleneck === null
        ? null
        : (COMPONENT_CRITERIA[bottleneck.label] ?? null),
  };
}

/** 격차가 큰 순서로 정렬한다. 어디부터 손대야 이득이 큰지 보여준다. */
export function adviseAll(stats: StatEntry[]): GrowthAdvice[] {
  return stats
    .map(adviseStat)
    .sort((a, b) => (b.gapToBest ?? 0) - (a.gapToBest ?? 0));
}
