import { describe, expect, it } from "vitest";

import { classifyBash } from "../src/bash.js";

/**
 * 분류기 구멍의 회귀 테스트.
 *
 * 조작 저항 재설계에서 확인된 구멍들이다. 전부 "활동은 그대로인데 counter 에서 빠지는"
 * 형태라 점수를 올리면서 동시에 관측을 없앤다. 다시 열리면 축이 조용히 실명한다.
 */

describe("스캔이 분류기 밖으로 빠지던 경로", () => {
  it("git grep 은 선두가 git 이라 안 잡혔다", () => {
    // 실측에서 스캔 트래픽의 26.5%(440건)가 이 형태였다.
    expect(classifyBash("git grep -n 'X' -- packages").isContentSearch).toBe(
      true,
    );
  });

  it("재귀 옵션 없이 글롭으로 다파일을 뒤지는 것도 스캔이다", () => {
    expect(classifyBash("grep -n 'X' app/*.ts").isContentSearch).toBe(true);
  });

  it("단일 파일 grep 은 여전히 스캔이 아니다", () => {
    expect(classifyBash("grep -n foo app/a.ts").isContentSearch).toBe(false);
  });
});

describe("파일 읽기가 분류기 밖으로 빠지던 경로", () => {
  it("awk 로 읽으면 잡힌다", () => {
    // 이름 목록이 cat·head·tail·bat·sed 다섯뿐이라 2,152건이 미판정이었다.
    expect(classifyBash("awk 'NR>10' app/foo.ts").isSourceRead).toBe(true);
  });

  it("python3 인라인 코드로 열어도 잡힌다", () => {
    expect(
      classifyBash(`python3 -c "print(open('app/foo.ts').read())"`)
        .isSourceRead,
    ).toBe(true);
  });

  it("node 인라인 코드로 열어도 잡힌다", () => {
    expect(
      classifyBash(`node -e "require('fs').readFileSync('app/foo.ts')"`)
        .isSourceRead,
    ).toBe(true);
  });

  it("스크립트 실행은 읽기가 아니다", () => {
    // 인자가 코드 파일이라는 것만으로 읽기라고 하면 빌드·테스트 실행이 통째로 위반이 된다.
    expect(classifyBash("node scripts/build.mjs").isSourceRead).toBe(false);
    expect(classifyBash("python3 tools/gen.py").isSourceRead).toBe(false);
  });

  it("경로에 /tmp/.. 를 끼워 임시경로 예외를 타지 못한다", () => {
    expect(classifyBash("cat /tmp/../Users/x/app/foo.ts").isSourceRead).toBe(
      true,
    );
  });

  it("진짜 임시 파일 읽기는 여전히 면제다", () => {
    expect(classifyBash("cat /tmp/scratch.log").isSourceRead).toBe(false);
  });
});

describe("껍데기와 묶기로 판정이 사라지던 경로", () => {
  it("bash -lc 로 감싼 커밋도 커밋이다", () => {
    // 안 잡히면 검증 신선도의 분모가 사라져 닫힌 구간이 28에서 8로 줄었다.
    // 점수를 올리는 게 아니라 관측을 없애는 종류다.
    expect(classifyBash(`bash -lc "git commit -m x"`).isCommit).toBe(true);
    expect(classifyBash(`sh -c 'git commit -m x'`).isCommit).toBe(true);
  });

  it("같은 종류를 && 로 묶어도 실행 횟수대로 센다", () => {
    // Set 이면 [tsc] 하나로 접혀 공회전이 안 보였다.
    expect(
      classifyBash("npx tsc --noEmit && npx tsc --noEmit && npx tsc --noEmit")
        .verifierKinds,
    ).toEqual(["tsc", "tsc", "tsc"]);
  });

  it("다른 종류를 묶는 것은 정상이라 각각 한 번이다", () => {
    expect(classifyBash("npx tsc && npx eslint .").verifierKinds).toEqual([
      "tsc",
      "eslint",
    ]);
  });
});
