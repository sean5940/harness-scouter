import { AXIS_LABELS, AXIS_ORDER, type AxisKey } from "./definitions.js";
import type { AxisDelta } from "./periods.js";

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

/**
 * 12시부터 시계방향으로 6등분한 꼭짓점.
 * 마주보는 자리가 대립쌍이 되도록 AXIS_ORDER가 배치돼 있다 (설계 5.4).
 */
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

/** 축 라벨을 축 방향으로 눕힌다. 아래쪽 절반은 뒤집어 읽는 방향을 맞춘다. */
function labelTransform(
  center: number,
  radius: number,
  index: number,
  count: number,
): string {
  const p = vertex(center, radius, index, count);
  let deg = ((360 * index) / count) % 360;
  if (deg > 90 && deg < 270) deg -= 180;
  return `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${deg.toFixed(1)})`;
}

/**
 * 6축 레이더를 SVG 문자열로 그린다.
 *
 * Webview는 CSP 때문에 외부 차트 라이브러리를 못 불러온다. 축 6개짜리 레이더는
 * 직접 그리는 편이 짧고, 의존성이 없어 확장 번들도 가벼워진다.
 *
 * 도형이 셋이다. 굵은 정육각형은 눈금 상한, 파선은 기준 구간(직전 3구간 중앙값),
 * 채운 면은 이번 구간이다. 기준을 넘는 방향이 개선이므로 눈금 상한은 두 계열의
 * 최댓값에서 잡아 현재 값이 잘리지 않게 한다.
 */
export function renderRadarSvg(
  axes: AxisDelta[],
  options: RadarOptions = {},
): string {
  const size = options.size ?? 520;
  const rings = options.rings ?? 5;
  const center = size / 2;
  const labelPad = 74;
  const maxRadius = center - labelPad;
  const count = AXIS_ORDER.length;

  const byKey = new Map<AxisKey, AxisDelta>(axes.map((a) => [a.key, a]));

  // 기준을 넘는 값이 잘리지 않도록 눈금 상한을 두 계열의 최댓값에서 잡는다.
  const observed = axes.flatMap((a) => [a.current ?? 0, a.baseline ?? 0]);
  const peak = Math.max(1, ...observed) * 1.02;
  const scale = (value: number): number => (value / peak) * maxRadius;

  const gray = options.grayedOut === true;
  const gridColor = gray ? "var(--hs-grid-muted)" : "var(--hs-grid)";
  const baseColor = gray ? "var(--hs-muted)" : "var(--hs-baseline)";
  const currColor = gray ? "var(--hs-muted)" : "var(--hs-current)";

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${size} ${size}" width="100%" role="img" aria-label="하네스 6축 레이더">`,
  );

  // 눈금: 동심 육각형. 가장 바깥은 실선, 안쪽은 점선.
  for (let ring = rings; ring >= 1; ring -= 1) {
    const r = (maxRadius * ring) / rings;
    const pts = Array.from({ length: count }, (_, i) =>
      vertex(center, r, i, count),
    );
    const isOuter = ring === rings;
    parts.push(
      `<polygon points="${polygon(pts)}" fill="none" stroke="${gridColor}" stroke-width="${
        isOuter ? 1.2 : 0.8
      }"${isOuter ? "" : ' stroke-dasharray="4 4"'} />`,
    );
  }

  // 축선
  for (let i = 0; i < count; i += 1) {
    const p = vertex(center, maxRadius, i, count);
    parts.push(
      `<line x1="${center}" y1="${center}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(
        1,
      )}" stroke="${gridColor}" stroke-width="0.8" />`,
    );
  }

  // 바깥 경계: 정육각형 굵은 실선. 레퍼런스의 파란 테두리에 해당한다.
  const boundaryPts = Array.from({ length: count }, (_, i) =>
    vertex(center, maxRadius, i, count),
  );
  parts.push(
    `<polygon points="${polygon(
      boundaryPts,
    )}" fill="none" stroke="${baseColor}" stroke-width="6" stroke-linejoin="round" />`,
  );

  const baselinePts: Point[] = [];
  const currentPts: Point[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = AXIS_ORDER[i] as AxisKey;
    const axis = byKey.get(key);
    baselinePts.push(vertex(center, scale(axis?.baseline ?? 0), i, count));
    currentPts.push(vertex(center, scale(axis?.current ?? 0), i, count));
  }

  // 기준 계열: 얇은 파선. 현재 계열이 이 선을 넘는 방향이 개선이다.
  parts.push(
    `<polygon points="${polygon(
      baselinePts,
    )}" fill="none" stroke="${baseColor}" stroke-width="1.6" stroke-dasharray="6 4" stroke-linejoin="round" opacity="0.75" />`,
  );

  // 현재 계열: 옅은 채움 + 진한 외곽선
  parts.push(
    `<polygon points="${polygon(
      currentPts,
    )}" fill="${currColor}" fill-opacity="0.2" stroke="${currColor}" stroke-width="3.5" stroke-linejoin="round" />`,
  );

  // 꼭짓점 마커. 바깥 경계 위에 얹어 레퍼런스와 같은 자리에 둔다.
  for (const p of boundaryPts) {
    parts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6" fill="${baseColor}" />`,
    );
  }

  // 축 라벨과 값
  for (let i = 0; i < count; i += 1) {
    const key = AXIS_ORDER[i] as AxisKey;
    const axis = byKey.get(key);
    const value =
      axis?.current === null || axis?.current === undefined
        ? "—"
        : `${(axis.current * 100).toFixed(0)}%`;
    const deltaText =
      axis?.delta === null || axis?.delta === undefined
        ? ""
        : `${axis.delta >= 0 ? "▲" : "▼"}${Math.abs(axis.delta * 100).toFixed(0)}`;
    const deltaFill =
      axis?.delta === null || axis?.delta === undefined || gray
        ? "var(--hs-muted)"
        : axis.delta >= 0
          ? "var(--hs-up)"
          : "var(--hs-down)";
    const unfilledMark = axis?.unfilled === true ? " ⚠" : "";

    parts.push(
      `<g transform="${labelTransform(center, maxRadius + 40, i, count)}">` +
        `<text text-anchor="middle" y="-3" font-size="13.5" font-weight="600" fill="var(--hs-text)">${
          AXIS_LABELS[key]
        }${unfilledMark}</text>` +
        `<text text-anchor="middle" y="15" font-size="12.5" fill="var(--hs-text-dim)">${value}` +
        (deltaText === ""
          ? ""
          : ` <tspan fill="${deltaFill}">${deltaText}</tspan>`) +
        `</text></g>`,
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}
