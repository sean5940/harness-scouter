/**
 * 명령줄 토큰을 명령 하나와 플래그 맵으로 나눈다.
 *
 * index.ts 는 임포트하는 즉시 main() 을 돌리므로 여기에 따로 둔다. 파싱만 떼어 두면
 * CLI 를 실행하지 않고 규칙을 검증할 수 있다.
 */
export function parseArgs(argv: string[]): {
  command: string;
  flags: Map<string, string>;
} {
  // 첫 토큰이 플래그면 명령이 없는 호출이다. `scouter --lang klingon` 을 명령 이름으로
  // 읽으면 언어 오류 대신 "알 수 없는 명령"이 나와 무엇이 틀렸는지 알 수 없다.
  const first = argv[0];
  const named = first !== undefined && !first.startsWith("--");
  const command = named ? first : "help";
  const flags = new Map<string, string>();
  for (let i = named ? 1 : 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const body = token.slice(2);
    // `--lang=ko` 처럼 등호로 붙인 값도 받는다. 등호를 안 보면 키가 `lang=ko` 로 잡혀
    // 플래그가 조용히 무시되고 기본값으로 떨어진다. 틀렸다는 신호가 없어 더 나쁘다.
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    flags.set(
      body,
      next !== undefined && !next.startsWith("--") ? next : "true",
    );
    if (next !== undefined && !next.startsWith("--")) i += 1;
  }
  return { command, flags };
}
