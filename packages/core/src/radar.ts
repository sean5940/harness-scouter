import type { StatEntry } from "./stats.js";
import { L, t, type Lang } from "./i18n.js";

export interface RadarOptions {
  size?: number;
  /** 눈금 단계 수. 레퍼런스는 5단계 동심 육각형이다. */
  rings?: number;
  /** 커버리지 미달이면 전체를 회색으로 그린다 (설계 6.1). */
  grayedOut?: boolean;
}

interface Point {
  x: number;
  y: number;
}

/** 12시부터 시계방향으로 6등분한 꼭짓점. */
function vertex(
  center: number,
  radius: number,
  index: number,
  count: number,
): Point {
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
  };
}

function polygon(points: Point[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/**
 * 라벨을 수평으로 두고 위치에 따라 정렬만 바꾼다.
 *
 * 레퍼런스는 축 방향으로 눕히지만 한글은 눕히면 읽기가 크게 나빠진다. 매일 보는
 * 화면이라 모양보다 가독성을 택했다.
 */
function labelAnchor(
  index: number,
  count: number,
): {
  x: number;
  y: number;
  anchor: string;
} {
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const anchor = Math.abs(cos) < 0.25 ? "middle" : cos > 0 ? "start" : "end";
  return { x: cos, y: sin, anchor };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 능력치 레이더를 SVG 문자열로 그린다.
 *
 * Webview는 CSP 때문에 외부 차트 라이브러리를 못 불러온다. 축 6개짜리 레이더는
 * 직접 그리는 편이 짧고, 의존성이 없어 확장 번들도 가벼워진다.
 *
 * 도형이 셋이다. 굵은 정육각형은 100점 경계, 파선은 개인 최고, 채운 면은 현재다.
 * 기준선을 직전 구간이 아니라 개인 최고로 잡은 이유는 M0.5에서 구간 간 안정성이
 * 없다고 확인됐기 때문이다(설계 8.1). 이웃 구간과 비교하면 잡음을 성장으로 읽는다.
 */
export function renderRadarSvg(
  stats: StatEntry[],
  lang: Lang,
  options: RadarOptions = {},
): string {
  const size = options.size ?? 540;
  const rings = options.rings ?? 5;
  const center = size / 2;
  const maxRadius = center - 92;
  const count = stats.length;
  if (count === 0) return "";

  // 점수가 0~100이라 눈금 상한이 고정된다. 동적 스케일을 쓰면 창마다 도형 크기의
  // 의미가 달라져 두 창을 나란히 못 읽는다.
  const scale = (score: number | null): number =>
    score === null ? 0 : (Math.max(0, Math.min(100, score)) / 100) * maxRadius;

  const gray = options.grayedOut === true;
  const gridColor = gray ? "var(--hs-grid-muted)" : "var(--hs-grid)";
  const edgeColor = gray ? "var(--hs-muted)" : "var(--hs-baseline)";
  const fillColor = gray ? "var(--hs-muted)" : "var(--hs-current)";

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${size} ${size}" width="100%" role="img" aria-label="${escapeHtml(t(L("하네스 능력치 레이더", "Harness stat radar"), lang))}">`,
  );

  for (let ring = rings; ring >= 1; ring -= 1) {
    const r = (maxRadius * ring) / rings;
    const pts = Array.from({ length: count }, (_, i) =>
      vertex(center, r, i, count),
    );
    const isOuter = ring === rings;
    parts.push(
      `<polygon points="${polygon(
        pts,
      )}" fill="none" stroke="${gridColor}" stroke-width="${
        isOuter ? 1.2 : 0.8
      }"${isOuter ? "" : ' stroke-dasharray="4 4"'} />`,
    );
  }

  for (let i = 0; i < count; i += 1) {
    const p = vertex(center, maxRadius, i, count);
    parts.push(
      `<line x1="${center}" y1="${center}" x2="${p.x.toFixed(
        1,
      )}" y2="${p.y.toFixed(1)}" stroke="${gridColor}" stroke-width="0.8" />`,
    );
  }

  const boundary = Array.from({ length: count }, (_, i) =>
    vertex(center, maxRadius, i, count),
  );
  parts.push(
    `<polygon points="${polygon(
      boundary,
    )}" fill="none" stroke="${edgeColor}" stroke-width="6" stroke-linejoin="round" />`,
  );

  const bestPoints = stats.map((s, i) =>
    vertex(center, scale(s.best), i, count),
  );
  const currentPoints = stats.map((s, i) =>
    vertex(center, scale(s.score), i, count),
  );

  parts.push(
    `<polygon points="${polygon(
      bestPoints,
    )}" fill="none" stroke="${edgeColor}" stroke-width="1.6" stroke-dasharray="6 4" stroke-linejoin="round" opacity="0.7" />`,
  );
  parts.push(
    `<polygon points="${polygon(
      currentPoints,
    )}" fill="${fillColor}" fill-opacity="0.2" stroke="${fillColor}" stroke-width="3.5" stroke-linejoin="round" />`,
  );

  for (const p of boundary) {
    parts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(
        1,
      )}" r="6" fill="${edgeColor}" />`,
    );
  }

  stats.forEach((stat, i) => {
    const value = stat.score === null ? "—" : stat.score.toFixed(0);
    const rankColor =
      gray || stat.rank === "-" ? "var(--hs-muted)" : rankFill(stat.rank);
    const dir = labelAnchor(i, count);
    const labelRadius = maxRadius + 26;
    const x = center + dir.x * labelRadius;
    // 위아래 꼭짓점은 라벨이 도형과 겹치므로 바깥으로 더 민다.
    const dy = dir.y < -0.9 ? -12 : dir.y > 0.9 ? 22 : 0;
    const y = center + dir.y * labelRadius + dy;
    parts.push(
      `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
        `<text text-anchor="${dir.anchor}" y="-2" font-size="13.5" font-weight="600" fill="var(--hs-text)">${escapeHtml(
          t(stat.label, lang),
        )}</text>` +
        `<text text-anchor="${dir.anchor}" y="16" font-size="12.5" fill="var(--hs-text-dim)">${value}` +
        ` <tspan font-weight="700" fill="${rankColor}">${stat.rank}</tspan>` +
        `</text></g>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}

export function rankFill(rank: string): string {
  if (rank === "S") return "var(--hs-rank-s)";
  if (rank === "A") return "var(--hs-rank-a)";
  if (rank === "B") return "var(--hs-rank-b)";
  if (rank === "C") return "var(--hs-rank-c)";
  if (rank === "D") return "var(--hs-rank-d)";
  return "var(--hs-muted)";
}
