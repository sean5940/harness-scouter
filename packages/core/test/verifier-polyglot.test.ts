import { describe, expect, it } from "vitest";

import { classifyBash } from "../src/definitions.js";
import { computeSessionMetrics } from "../src/metrics.js";
import type { ToolCallRecord } from "../src/db.js";

/**
 * 검증 분류기가 JS 생태계 밖에서도 서는지 본다.
 *
 * 첫 판은 `tsc`·`eslint`·`jest` 같은 명령 이름 목록이었다. 그래서 Go·Swift 하네스에서는
 * 검증이 거의 안 잡혔고, 화면은 "커밋 전 검증 신선도 0%" 라고 말했다. 0% 는 검증을 안
 * 했다는 뜻이 아니라 우리가 못 알아봤다는 뜻이었는데, 화면에는 그 구분이 없었다.
 *
 * 그래서 이 파일은 두 세계를 함께 둔다. 검증인 세계(`go test`)와 검증이 아닌 세계
 * (`go run`·`go mod tidy`)를 나란히 놓고 앞에서만 반응하는지 본다. 인식 건수가 늘어난
 * 것은 검증이 아니다. 늘면 안 되는 것이 안 늘어야 검증이다.
 */

let seq = 0;
function call(over: Partial<ToolCallRecord>): ToolCallRecord {
  seq += 1;
  return {
    seq,
    name: "Bash",
    command: null,
    file_path: null,
    is_error: 0,
    denial_kind: null,
    is_sidechain: 0,
    agent_id: null,
    total_lines: null,
    num_lines: null,
    start_line: null,
    edit_type: null,
    subagent_tool_calls: null,
    subagent_edit_files: null,
    stdout_tail: "ok",
    ...over,
  } as unknown as ToolCallRecord;
}

/** 코드를 고치고, 주어진 명령으로 검증하고, 커밋하는 세션. */
function freshnessOf(verifier: string, editPath: string) {
  seq = 0;
  return computeSessionMetrics("s", [
    call({ name: "Edit", file_path: editPath, edit_type: "update" }),
    call({ name: "Bash", command: verifier }),
    call({ name: "Bash", command: "git commit -m x" }),
  ]).axes.verificationFreshness;
}

describe("검증인 것과 아닌 것을 언어와 무관하게 가른다", () => {
  it.each([
    ["go test ./...", "test"],
    ["go build ./...", "build"],
    ["go vet ./...", "lint"],
    ["gofmt -l .", "format"],
    ["golangci-lint run", "lint"],
    ["cargo test", "test"],
    ["cargo clippy -- -D warnings", "lint"],
    ["swift build", "build"],
    ["swift test --filter LoginTests", "test"],
    ["xcodebuild -scheme App -destination generic/platform=iOS test", "test"],
    ["mvn verify", "build"],
    ["./gradlew test", "test"],
    ["dotnet test", "test"],
    ["dart analyze", "typecheck"],
    ["flutter test", "test"],
    ["pytest tests/", "test"],
    ["mypy src/", "typecheck"],
    ["ruff check .", "lint"],
    ["shellcheck scripts/run.sh", "lint"],
    ["make test", "test"],
    ["make lint", "lint"],
    ["just check", "test"],
  ])("%s → %s", (command, kind) => {
    expect(classifyBash(command).verifierKinds).toContain(kind);
  });

  it.each([
    "go run ./cmd/server",
    "go mod tidy",
    "go generate ./...",
    "cargo run",
    "cargo add serde",
    "make deploy",
    "dotnet restore",
    "swift package resolve",
    "git log --oneline",
  ])("%s 는 검증이 아니다", (command) => {
    expect(classifyBash(command).verifierKinds).toEqual([]);
  });

  it("`-v` 는 도구마다 뜻이 달라 도구를 보고 가른다", () => {
    // `tsc -v` 는 판버전이고 `go test -v` 는 자세히 보기다. 한쪽으로 몰면 반드시
    // 한쪽이 틀린다. 어디서나 판버전으로 보면 Go·Python 하네스의 가장 흔한 검증이
    // 통째로 빠지고, 어디서도 안 보면 판버전 조회가 검증이 된다.
    expect(classifyBash("npx vitest -v").verifierKinds).toEqual([]);
    expect(classifyBash("go test -v ./...").verifierKinds).toContain("test");
    expect(classifyBash("pytest -v").verifierKinds).toContain("test");
  });

  it("포맷 명령은 다시 쓰기라 검증이 아니고, 보기만 할 때만 검증이다", () => {
    // `prettier --write` 를 검증에서 빼는 것과 같은 이유다. 고치는 실행은 그 트리가
    // 옳다는 근거가 못 된다.
    expect(classifyBash("go fmt ./...").verifierKinds).toEqual([]);
    expect(classifyBash("cargo fmt").verifierKinds).toEqual([]);
    expect(classifyBash("cargo fmt --check").verifierKinds).toContain("format");
  });

  it("검증을 도는 셸 스크립트는 이름을 종류로 남긴다", () => {
    // 종류를 하나로 접으면 서로 다른 검증 스크립트 두 개를 돌린 것이 같은 것의
    // 재실행으로 잡혀 공회전이 된다.
    expect(classifyBash("./verify-metrics.sh").verifierKinds).toEqual([
      "verify-metrics.sh",
    ]);
    expect(classifyBash("bash scripts/check-docs.sh").verifierKinds).toEqual([
      "check-docs.sh",
    ]);
    expect(
      classifyBash("./verify-a.sh && ./verify-b.sh").verifierKinds,
    ).toEqual(["verify-a.sh", "verify-b.sh"]);
    expect(classifyBash("./deploy.sh").verifierKinds).toEqual([]);
  });
});

describe("Go 의 패키지 패턴은 모듈 전체를 겨눈 것이다", () => {
  it("`./...` 은 무엇을 고쳤든 덮는다", () => {
    // 이걸 경로로 그대로 두면 어느 편집 경로와도 안 맞아, 가장 흔한 Go 검증이
    // "고친 것을 안 덮은 검증" 으로 잡히고 신선도가 통째로 0 이 된다.
    expect(freshnessOf("go test ./...", "internal/auth/token.go")).toEqual({
      num: 1,
      den: 1,
    });
  });

  it("`./pkg/...` 은 그 아래만 덮는다", () => {
    expect(
      freshnessOf("go test ./internal/...", "internal/auth/token.go"),
    ).toEqual({
      num: 1,
      den: 1,
    });
    expect(freshnessOf("go test ./internal/...", "cmd/server/main.go")).toEqual(
      {
        num: 0,
        den: 1,
      },
    );
  });

  it("셸이 앞에 서도 스크립트 자기 이름을 검증 대상으로 세지 않는다", () => {
    expect(
      freshnessOf("bash scripts/verify.sh", "internal/auth/token.go"),
    ).toEqual({
      num: 1,
      den: 1,
    });
  });
});

describe("Go 하네스에서 신선도가 0 이던 세계", () => {
  it("go test 로 검증하고 커밋하면 신선하다", () => {
    // 보고된 코퍼스의 모양이다. `git commit` 이 있는 세션 312개 중 296개가 검증을
    // 했는데도 인식이 안 돼 0% 로 나왔다.
    expect(freshnessOf("go test ./...", "internal/auth/token.go")).toEqual({
      num: 1,
      den: 1,
    });
    expect(freshnessOf("make verify", "internal/auth/token.go")).toEqual({
      num: 1,
      den: 1,
    });
  });

  it("아무 검증도 없으면 그대로 신선하지 않다", () => {
    // 인식 범위를 넓힌 것이 "무엇이든 검증으로 센다" 가 되면 안 된다.
    expect(
      freshnessOf("go run ./cmd/server", "internal/auth/token.go"),
    ).toEqual({ num: 0, den: 1 });
  });
});
