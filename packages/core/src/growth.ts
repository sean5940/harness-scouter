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

/**
 * 목표의 성격. 구성요소마다 정확히 하나.
 *
 * 등급을 그 사람의 이력 백분위로 매기면 "내 평소보다 나은가"에는 답하지만
 * "이 하네스가 좋은 하네스인가"에는 못 답한다. 다른 사람 하네스를 평가하려면
 * 구성요소마다 목표가 어디서 오는지를 밝혀야 한다.
 *
 *  ceiling      정의역 안에서 100 이 원리적 목표이고, 못 채운 만큼이 그대로 결함이다.
 *  directional  높을수록 좋지만 100 을 목표로 둘 근거가 없다.
 *  guarded      양극단이 모두 나쁜 것을 뜻할 수 있어 방향 해석부터 갈린다.
 */
export type Objective = "ceiling" | "directional" | "guarded";

/**
 * 비교 가능성을 깎는 오염. 0개 이상 붙는다.
 *
 * 초판은 이것을 목표 성격과 한 축에 섞었다. 그런데 "훅을 깔면 값이 오른다"는 목표의
 * 성격이 아니라 측정의 오염이라 층이 다르다. 섞어 두면 `ceiling` 이면서 비교 불가인
 * 구성요소를 표현할 수 없다.
 *
 *  gate-coupled    차단 훅·권한 규칙을 설치하면 행동이 같아도 값이 움직인다.
 *                  차단된 호출을 축 계산에서 빼기 때문이다.
 *  channel-bound   분자나 분모가 특정 도구 이름이나 결과 스키마 필드로 정의돼 있어,
 *                  이름이 다른 하네스에서는 그 활동이 계상에서 통째로 빠진다.
 *  mix-conditional 세션의 작업 구성(탐색 위주냐 편집 위주냐)이 값을 좌우해
 *                  사람이 아니라 그날 한 일을 잰다.
 */
export type Contamination =
  "gate-coupled" | "channel-bound" | "mix-conditional";

export const OBJECTIVE_LABELS: Record<Objective, string> = {
  ceiling: "100이 목표",
  directional: "높을수록 좋음",
  guarded: "양극단 주의",
};

export const CONTAMINATION_LABELS: Record<Contamination, string> = {
  "gate-coupled": "훅 설치가 값을 움직임",
  "channel-bound": "도구 이름에 묶임",
  "mix-conditional": "작업 구성에 좌우",
};

export interface ComponentCriterion {
  /** 무엇을 세는가. 분자와 분모를 사람 말로. */
  measures: string;
  /** 이 값이 낮으면 실무에서 무엇이 나빠지는가. */
  whyItMatters: string;
  /** 목표가 어디서 오는가. 코드 고정이고 설정으로 못 바꾼다. */
  objective: Objective;
  /** 비교 가능성을 깎는 오염. 하나라도 있으면 사람 간 비교에 쓰지 않는다. */
  contamination: Contamination[];
  /** 그 성격으로 본 근거. 왜 100 이 목표인지, 왜 오염됐는지. */
  targetBasis: string;
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
  "파일 찾기 규율": {
    measures:
      "파일 경로를 찾을 때 `Glob` 도구로 간 비율. `find … -name` 이 분모의 나머지다.",
    whyItMatters:
      "파일 찾기는 인덱스로 대체할 수 없다. 계측 도구로 하면 어떤 파일을 왜 열었는지가 기록에 남고, bash 로 하면 그 흔적이 사라져 다른 능력치도 함께 실명한다.",
    objective: "ceiling",
    contamination: ["gate-coupled", "channel-bound"],
    targetBasis:
      "`Glob` 은 모든 설치에 있고 `find -name` 과 같은 일을 한다. Glob 으로 대체할 수 없는 형태는 분모에서 뺐다. 다만 차단된 호출이 축에서 빠지므로 게이트를 깔면 값이 오르고(실측 19.0 → 21.2), `Glob` 이라는 이름에 묶여 있어 사람 간 비교에는 못 쓴다.",
    actions: [
      "`find … -name` 을 `Glob` 도구로 바꾼다. 같은 일을 하고 결과도 같다.",
      "검색 게이트 훅이 `find` 를 잡을 때 qmd 가 아니라 `Glob` 을 권하도록 메시지를 고친다. 작업에 안 맞는 대안을 주면 그냥 포기한다.",
    ],
    antipatterns: [
      "`Glob` 을 의미 없이 여러 번 호출해 분모를 키우기.",
      "파일을 못 찾은 채로 짐작해서 편집하기. 근거 확보율이 대신 떨어진다.",
    ],
  },
  "근거 확보율": {
    measures:
      "기존 코드 파일을 고칠 때 그 파일을 먼저 읽은 비율. 새로 만든 파일은 읽을 것이 없어 분모에서 뺀다.",
    whyItMatters:
      "탐색력의 다른 구성요소는 검색한 것들 중 비율만 보므로, 아예 안 찾고 고친 경우를 못 잡는다. 실측에서 코드 편집 다섯 건 중 한 건이 근거 없이 이뤄졌다.",
    objective: "ceiling",
    contamination: ["channel-bound"],
    targetBasis:
      "기존 파일을 안 읽고 고치는 것은 정당화되지 않는다. 새 파일은 분모에서 뺐다. 오염이 채널 하나뿐이라 어댑터만 맞추면 절대 비교가 되는 유일한 구성요소다.",
    actions: [
      "편집 전에 그 파일의 해당 범위를 읽는다. 전체를 읽을 필요는 없다.",
      "위임 brief 에 편집 대상 파일과 읽을 라인 범위를 함께 적는다. subagent 는 범위를 안 주면 읽지 않고 고치거나 통째로 연다.",
    ],
    antipatterns: [
      "형식만 채우려고 파일을 통째로 읽기. 읽기 범위 규율과 컨텍스트 경량성이 대신 떨어진다.",
    ],
  },
  "내용 인덱스 우선": {
    measures:
      "내용·관계를 찾을 때 qmd query·graphify 로 간 비율. MCP 도구와 CLI(`graphify explain`·`INDEX_PATH=… qmd query`)를 모두 센다. `grep -r`·`rg`·`Grep` 도구가 분모의 나머지다. 조회·진단 계열(`qmd get`·`status`·`bench`, `graphify stats`·`god`)은 검색이 아니라 세지 않는다.",
    whyItMatters:
      "전수 스캔은 결과가 많고 관련도 순서가 없어 읽는 토큰이 늘고, 찾은 뒤에도 어느 것이 맞는지 다시 골라야 한다.",
    objective: "directional",
    contamination: ["gate-coupled", "channel-bound"],
    targetBasis:
      "인덱스를 안 깐 하네스는 0 에 가깝고 그것 자체가 하네스 품질이다. 다만 처음 보는 리터럴 조회처럼 전수 스캔이 맞는 경우가 있어 원리적 상한이 없다. 게이트 설치가 값을 올린다(실측 40.5 → 46.8).",
    actions: [
      "탐색 위임 brief에 `qmd query`·`graphify query`를 호출 순서까지 명시한다. subagent는 지시하지 않은 도구를 쓰지 않는다.",
      "검색 게이트 훅의 matcher가 `find … -name`과 `-iname`을 잡는지 확인한다. `grep -r`·`rg`만 잡고 있으면 우회가 그대로 통과한다.",
      "스킬 본문 탐색 단계에 대체 경로를 명령형으로 적는다. 금지만 있고 대안이 없는 규칙은 재발률이 높다.",
    ],
    antipatterns: [
      "`grep -r` 을 `Grep` 도구로만 바꾸기. 채널만 바뀌고 하는 일은 내용 전수 스캔 그대로라 점수가 오르지 않는다.",
      "`git grep` 이나 비재귀 글롭 `grep` 으로 스캔을 분류기 밖으로 빼기. 지금은 둘 다 잡히지만, 분류기가 모르는 검색 도구를 새로 쓰면 같은 구멍이 다시 열린다.",
      "결과를 안 읽는 `qmd query` 를 스캔 앞에 한 번씩 던져 분모만 키우기. `qmd get`·`status` 는 막았지만 `query` 반복은 열려 있다.",
    ],
  },
  "검색 한 번에 찾기": {
    measures: "재귀검색 중 같은 검색어를 세션 안에서 다시 찾은 비율의 역수.",
    whyItMatters:
      "같은 것을 또 찾는다는 것은 첫 검색의 범위나 패턴이 틀렸다는 뜻이다.",
    objective: "directional",
    contamination: ["mix-conditional"],
    targetBasis:
      "첫 검색이 틀릴 수 있는 정당한 경우가 있다. 상한을 100 으로 두면 탐색 자체를 줄이는 쪽이 유리해진다.",
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
    objective: "directional",
    contamination: ["mix-conditional", "channel-bound"],
    targetBasis:
      "ceiling 이 아니다. 게이트의 상한 도달 검사가 미달이다. 커밋 호출에 결과를 안 보는 verifier 를 붙이면 행동이 그대로인 채 100 에 닿는다(88.3 → 100.0). 행동 불변으로 상한에 닿는 지표는 못 채운 만큼이 결함이라고 말할 수 없다.",
    actions: [
      "게이트를 커밋 시점으로 옮긴다. `PreToolUse:Bash`에서 `git commit`을 잡아 마지막 편집 이후 verifier가 없으면 차단한다.",
      "차단 메시지에 대안 경로를 문장으로 넣는다. 금지만 통보하면 재발하고, 대체 명령을 주면 재발이 줄었다.",
      "리뷰 지적을 반영한 뒤 재검증하는 단계를 리뷰 스킬 종료 절차에 넣는다.",
    ],
    antipatterns: [
      'CLAUDE.md에 "항상 tsc를 돌려라"를 넣기. 신선도는 오르고 공회전이 같이 튄다.',
      "`tsc && eslint && test`를 훅으로 강제하기. 행동은 그대로인데 점수만 오른다.",
      "커밋 앞에 `npx tsc --version;` 처럼 결과를 안 보는 verifier 를 접합하기. 신선도 판정은 종류와 순서만 봐서 그대로 통과한다.",
    ],
  },
  "검증 공회전 없음": {
    measures: "verifier 호출 중, 편집 없이 같은 종류를 다시 돌린 것의 역수.",
    whyItMatters:
      "실패를 못 읽어서 같은 검증을 반복하는 경우가 많다. 검증 호출의 상당수가 파이프로 exit code를 삼킨다.",
    objective: "directional",
    contamination: ["mix-conditional"],
    targetBasis:
      "편집 없이 다시 돌리는 것이 맞는 경우가 드물게 있다(비동기 대기, 플레이키 확인).",
    actions: [
      "스킬의 검증 스텝을 개별 나열 대신 `tsc && eslint && prettier --check` 단일 명령으로 못박는다.",
      'verifier에 `; echo "EXIT=$?"`를 붙이도록 훅에서 리라이트한다. 조작 방향이 없는 드문 안전한 훅이다. 점수는 stdout 파싱으로 매기므로 exit code 노출이 점수를 올리지 않는다.',
    ],
    antipatterns: [
      "검증 횟수 상한을 훅으로 걸기. 수정 후 재검증까지 막힌다.",
      "검증 사이에 파일을 한 번 고쳐 같은 종류 판정을 리셋하기. 편집이 판정을 비우는 구조라 실측 689건이 이렇게 지워지고 있다.",
      "같은 종류를 `&&` 로 한 호출에 묶기. 지금은 실행 횟수를 세지만, 종류를 조금씩 바꿔 돌리면 여전히 반복이 안 보인다. 서로 다른 종류를 묶는 것은 정상이다.",
    ],
  },
  "산출물 도달": {
    measures: "코드를 고친 세션 중 커밋이나 PR까지 간 비율.",
    whyItMatters: "고쳐놓고 안 남기면 다음 세션이 같은 자리에서 다시 시작한다.",
    objective: "directional",
    contamination: ["mix-conditional"],
    targetBasis:
      "탐색만 하는 세션은 커밋이 없는 것이 정상이다. 100 을 목표로 두면 의미 없는 커밋이 유리해진다.",
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
    objective: "directional",
    contamination: ["channel-bound"],
    targetBasis:
      "일부 재작업은 학습이다. 100 은 처음부터 다 알았다는 뜻이라 현실적 목표가 아니다.",
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
    objective: "guarded",
    contamination: ["mix-conditional"],
    targetBasis:
      "100 은 아무도 지켜보지 않았다는 뜻일 수 있고, 낮으면 방향을 잘못 잡았다는 뜻이다. 양극단이 모두 나쁘므로 종합 점수에 넣지 않는다.",
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
      "편집과 bash 파일접근 중 계측 도구로 간 비율. `cat`·`awk`·인터프리터 읽기와 `sed -i`·heredoc 쓰기가 분자다. `Read` 호출은 분모에 없으므로 이름 그대로의 파일 접근 비율이 아니다.",
    whyItMatters:
      "bash로 파일을 고치면 다른 능력치도 함께 실명한다. 읽기 범위도 재작업도 검증 신선도도 그 편집을 못 본다.",
    objective: "directional",
    contamination: ["channel-bound"],
    targetBasis:
      "ceiling 이 아니다. 대응물 없는 형태가 분자에 실재한다(git 리비전 읽기, 다파일 루프, redirect-to-file). 그리고 분모가 편집과 bash 파일접근만 세고 `Read` 는 안 세므로 이름 그대로의 파일 접근 비율이 아니다.",
    actions: [
      "소스 읽기를 Read로 되돌린다. 프로젝트 규칙에 이미 있는 항목이므로 규칙이 아니라 집행이 빠진 것이다.",
      "파일 쓰기를 Edit·Write로 되돌린다. `python3 - <<EOF`로 파일을 여는 스크립트가 주 대상이다.",
      "분석용 heredoc과 파일 쓰기용 heredoc을 구분한다. stdout만 내는 것은 우회가 아니다.",
    ],
    antipatterns: [
      "예외 목록을 넓혀 점수 올리기. 측정값이 행동이 아니라 목록 편집에 반응하는 순간 축이 죽는다.",
      "명령을 `&&`로 이어붙여 호출 수 줄이기. 검증 신선도와 공회전 판정이 동시에 망가진다.",
      "`cat` 대신 `awk`·`python3`·`node` 로 같은 파일을 읽기. 지금은 잡히지만, 목록에 없는 도구로 읽으면 분자와 분모에서 동시에 빠져 축이 그 활동을 통째로 못 본다.",
    ],
  },
  "게이트 재발 없음": {
    measures:
      "훅이나 권한에 막힌 호출 중, 같은 에이전트가 이미 걸린 적 있는 게이트에 다시 걸리지 않은 비율. 차단이 하나도 없으면 분모가 없어 판정하지 않는다.",
    whyItMatters:
      "차단 건수 자체는 해석이 안 된다. 훅을 하나도 안 깐 하네스가 차단 0건으로 만점을 받기 때문이다. 같은 게이트에 또 걸린다는 것은 그 규칙을 모르거나 규칙이 실제 흐름과 안 맞는다는 뜻이고, 그건 차단 수와 달리 하네스의 문제를 가리킨다.",
    objective: "directional",
    contamination: ["gate-coupled"],
    targetBasis:
      "차단이 있어야 분모가 생기므로 센서 없는 하네스는 만점이 아니라 판정 불가다. 다만 오염이 사라지지는 않는다. 실측에서 차단의 95%가 훅이 아니라 권한 규칙(allowlist 누락)이라, 이 값은 상당 부분 allowlist 를 어떻게 구성했느냐를 잰다. 분모가 생기는 세션도 73%뿐이다.",
    actions: [
      "같은 게이트에 반복해서 걸리면 규칙이 아니라 스킬 본문을 고친다. 진단에서 재발 게이트를 확인한다.",
      "차단 메시지가 그 자리에서 쓸 대안 명령을 주는지 확인한다. 금지만 통보하는 게이트가 재발률이 높다.",
      "권한 차단이 반복되면 allowlist 에 그 형태를 넣는다. 실측 차단의 95%가 훅이 아니라 권한 규칙이다.",
    ],
    antipatterns: [
      "훅을 지워서 차단을 없애기. 분모가 사라져 점수가 오르는 것이 아니라 판정 불가가 되지만, 관측을 없애는 것은 여전히 나쁘다.",
      "차단될 때마다 조금씩 다른 명령으로 바꿔 게이트 신원을 흐리기.",
    ],
  },
  "읽기 범위 규율": {
    measures:
      "200줄 넘는 파일 읽기 중 범위를 지정한 비율. 파일 전체를 덮는 지정은 인정하지 않는다.",
    whyItMatters:
      "큰 파일을 통째로 읽으면 컨텍스트가 차고, 그 뒤 모든 턴이 그 무게를 계속 나른다.",
    objective: "directional",
    contamination: ["channel-bound"],
    targetBasis:
      "200줄 넘는 파일도 통째로 읽는 것이 맞을 때가 있다. 결과 스키마의 줄 수 필드에 묶여 있다.",
    actions: [
      "위임 brief 필수 요소에 읽을 라인 범위를 넣는다. subagent는 범위를 안 주면 통째로 연다.",
      "재읽기 상위 파일이 곧 스킬 진입 시 미리 넣었어야 할 컨텍스트 목록이다.",
      "200줄 넘는 레퍼런스 문서는 규칙을 고치지 말고 파일을 쪼갠다.",
    ],
    antipatterns: [
      "`limit: 2000`을 훅으로 주입하기. Read 기본 상한과 같아 아무것도 좁히지 않는데 부분읽기로 집계된다.",
      "`offset: 2`를 훅으로 주입하기. 시작줄이 1이 아니기만 하면 부분읽기로 잡혀서, 파일 전체를 읽어도 만점이 된다.",
      "chunk 순회로 잘게 쪼개기. 읽은 것 기억하기가 대신 떨어진다.",
    ],
  },
  "읽은 것 기억하기": {
    measures:
      "읽기 중 같은 파일을 다시 읽지 않은 비율. 편집 뒤 재확인은 정당하므로 뺀다.",
    whyItMatters:
      "같은 파일을 다시 연다는 것은 첫 읽기에서 필요한 것을 못 챙겼다는 뜻이다.",
    objective: "directional",
    contamination: ["channel-bound"],
    targetBasis:
      "긴 세션에서 재방문이 정당한 경우가 있다. 100 을 노리면 통째로 읽는 쪽이 유리해져 읽기 범위 규율과 충돌한다.",
    actions: [
      "`PostToolUse:Edit` 훅이 편집한 hunk의 전후 몇 줄을 돌려주게 하면 편집 후 재확인이 불필요해진다.",
      "같은 파일을 세 번 이상 연 세션의 스킬을 본다. 특정 스킬에 몰리면 그 스킬의 단계 순서가 잘못된 것이다.",
    ],
    antipatterns: [
      "파일을 통째로 읽어 재방문을 없애기. 읽기 범위 규율이 대신 떨어진다.",
      "재확인 전에 대상 파일을 한 번 고쳐 면제받기. 편집이 실질적인지 볼 근거가 없어 실측 476건이 이미 면제 중이다.",
      "두 번째 읽기를 subagent 로 넘기기. 에이전트가 다르면 재방문으로 안 세어진다.",
    ],
  },
  "응답 간결성": {
    measures:
      "읽기·편집 호출 한 번당 생성한 출력 토큰. 500토큰이 만점, 4,000토큰이 0점이다. 분모는 Read·Edit·Write 계열만 세고 Bash·검색은 빠진다.",
    whyItMatters:
      "같은 일을 하면서 길게 생성하면 비용과 지연이 함께 늘고, 읽는 사람의 부담도 커진다.",
    objective: "directional",
    contamination: ["channel-bound", "mix-conditional"],
    targetBasis:
      "비용에 앵커돼 있어 비교의 여지는 있으나, 분모가 읽기·편집 호출 수라 도구 이름이 바뀌면 통째로 사라진다.",
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
    objective: "directional",
    contamination: ["channel-bound"],
    targetBasis:
      "비용 앵커는 공유되지만 상한은 작업 규모에 좌우된다. usage 스키마의 캐시 필드에 묶여 있다.",
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
  /**
   * 개인 최고까지 남은 점수. 도달 가능성이 증명된 목표다.
   * 전수 집계 화면에서는 null 이다. 집계값은 이벤트 가중이고 최고는 구간 가중이라
   * 둘을 빼면 사과와 오렌지를 비교하게 된다.
   */
  gapToBest: number | null;
  /** 격차를 만든 구성요소. 가장 낮은 것을 고른다. */
  bottleneck: StatComponent | null;
  /**
   * 병목을 만점까지 올렸을 때 스탯이 실제로 오르는 몫.
   *
   * 구성요소가 많은 스탯일수록 하나를 고쳐도 덜 오른다. 이걸 안 보여주면 여지만 보고
   * 우선순위를 잘못 잡는다. 구성요소 4개짜리는 2개짜리의 절반만 닫힌다.
   */
  bottleneckGain: number | null;
  criterion: ComponentCriterion | null;
}

/**
 * 스탯 하나의 병목과 처방을 찾는다.
 *
 * 목표를 개인 최고로 잡는 이유는 그 값이 이 하네스로 도달 가능하다는 것이 이미
 * 관측됐기 때문이다. 임의의 절대 임계는 근거가 없고, 남과의 비교는 표본이 없다.
 */
export function adviseStat(
  stat: StatEntry,
  options: AdviceOptions = {},
): GrowthAdvice {
  let bottleneck: StatComponent | null = null;
  for (const component of stat.components) {
    if (component.value === null) continue;
    if (bottleneck === null || component.value < (bottleneck.value ?? 1)) {
      bottleneck = component;
    }
  }

  const scoredComponents = stat.components.filter(
    (c) => c.value !== null,
  ).length;
  const bottleneckGain =
    bottleneck === null || bottleneck.value === null || scoredComponents === 0
      ? null
      : ((1 - bottleneck.value) * 100) / scoredComponents;

  return {
    stat: stat.key,
    label: stat.label,
    score: stat.score,
    best: stat.best,
    gapToBest:
      options.allTime === true || stat.score === null || stat.best === null
        ? null
        : Math.max(0, stat.best - stat.score),
    bottleneck,
    bottleneckGain,
    criterion:
      bottleneck === null
        ? null
        : (COMPONENT_CRITERIA[bottleneck.label] ?? null),
  };
}

export interface AdviceOptions {
  /**
   * 전수 집계 화면인지.
   * 집계값과 구간 최고는 가중이 달라 격차를 빼면 안 된다. 대신 병목 심각도로 정렬한다.
   */
  allTime?: boolean;
}

/**
 * 손대서 얻는 이득이 큰 순서로 정렬한다.
 *
 * 구간 화면은 개인 최고까지의 격차로, 전수 화면은 병목을 고쳤을 때 닫히는 몫으로 정렬한다.
 * 전수에서 격차를 쓰면 이벤트 가중 집계값과 구간 가중 최고를 빼게 된다.
 */
export function adviseAll(
  stats: StatEntry[],
  options: AdviceOptions = {},
): GrowthAdvice[] {
  const advice = stats.map((stat) => adviseStat(stat, options));
  return options.allTime === true
    ? advice.sort((a, b) => (b.bottleneckGain ?? 0) - (a.bottleneckGain ?? 0))
    : advice.sort((a, b) => (b.gapToBest ?? 0) - (a.gapToBest ?? 0));
}
