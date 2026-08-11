/**
 * 파이프가 먼저 닫혔을 때 조용히 끝낸다.
 *
 * `scouter diag | head -3` 은 head 가 세 줄을 읽고 파이프를 닫는데, 그 뒤에 쓰기가 남아
 * 있으면 Node 가 EPIPE 를 error 이벤트로 올린다. 아무도 안 받으면 스택트레이스와 함께
 * 죽는다. 출력은 이미 다 나온 뒤라 사용자가 보는 것은 성공한 명령의 오류 화면이다.
 *
 * 셸에서 SIGPIPE 를 받은 프로그램은 조용히 끝난다. Node 는 SIGPIPE 를 무시하고 EPIPE 로
 * 바꿔 주기 때문에 그 관례가 사라지는데, 여기서 되살린다.
 *
 * EPIPE 가 아닌 쓰기 오류는 삼키지 않는다. 디스크가 찬 것과 파이프가 닫힌 것은 다른
 * 일이고, 전자를 조용히 넘기면 출력이 잘린 것을 아무도 모른다.
 */
export interface ErrorSource {
  on(
    event: "error",
    listener: (error: NodeJS.ErrnoException) => void,
  ): unknown;
}

export function guardBrokenPipe(
  stream: ErrorSource,
  onBrokenPipe: () => void,
): void {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") {
      onBrokenPipe();
      return;
    }
    throw error;
  });
}
