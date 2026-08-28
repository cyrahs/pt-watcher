import { useMemo, useState } from "react";
import { formatBytes, type TrafficDay } from "../api";

const W = 860;
const H = 220;
const MARGIN = { top: 10, right: 8, bottom: 22, left: 56 };

const SERIES_STORE_KEY = "trafficChart.series";

interface SeriesVisible {
  up: boolean;
  down: boolean;
}

function loadSeriesVisible(): SeriesVisible {
  try {
    const raw = localStorage.getItem(SERIES_STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<SeriesVisible>;
      const up = v.up !== false;
      const down = v.down !== false;
      // 两个都关等于没图，回退为全开
      if (up || down) return { up, down };
    }
  } catch {}
  return { up: true, down: true };
}

/** 补齐缺失日期（无流量的天数据库里没有行） */
function fillDays(daily: TrafficDay[], days: number): TrafficDay[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: TrafficDay[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push(byDay.get(key) ?? { day: key, uploadedBytes: 0, downloadedBytes: 0 });
  }
  return out;
}

/** 顶部圆角、底部贴基线的柱形 path */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(2, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log2(v));
  const step = 2 ** exp;
  return Math.ceil(v / step) * step;
}

export function TrafficChart({ daily, days }: { daily: TrafficDay[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [visible, setVisible] = useState<SeriesVisible>(loadSeriesVisible);

  const toggle = (key: keyof SeriesVisible) => {
    setVisible((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // 至少保留一个系列可见
      if (!next.up && !next.down) return prev;
      try {
        localStorage.setItem(SERIES_STORE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const data = useMemo(() => fillDays(daily, days), [daily, days]);
  // y 轴只按勾选的系列缩放：下载往往远大于上传，隐藏下载后上传不再被压成一条线
  const max = niceMax(
    Math.max(
      ...data.map((d) =>
        Math.max(visible.up ? d.uploadedBytes : 0, visible.down ? d.downloadedBytes : 0),
      ),
    ),
  );

  const seriesCount = (visible.up ? 1 : 0) + (visible.down ? 1 : 0);
  const plotW = W - MARGIN.left - MARGIN.right;
  const plotH = H - MARGIN.top - MARGIN.bottom;
  const slot = plotW / data.length;
  const barW = Math.max(2, (slot - 6) / Math.max(seriesCount, 1));
  const groupW = barW * seriesCount + (seriesCount - 1) * 2;
  const yOf = (v: number) => MARGIN.top + plotH * (1 - v / max);
  const labelEvery = Math.ceil(data.length / 6);

  const hovered = hover != null ? data[hover] : null;

  return (
    <>
      <div className="chart-header">
        <div className="chart-series-picker">
          <label>
            <input type="checkbox" checked={visible.up} onChange={() => toggle("up")} />
            <span className="dot up" /> 上传
          </label>
          <label>
            <input type="checkbox" checked={visible.down} onChange={() => toggle("down")} />
            <span className="dot down" /> 下载
          </label>
        </div>
      </div>
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`近${days}天每日上传/下载流量柱状图`}>
          {/* 网格与 y 轴刻度 */}
          {[0, 0.5, 1].map((f) => {
            const v = max * f;
            const y = yOf(v);
            return (
              <g key={f}>
                <line x1={MARGIN.left} x2={W - MARGIN.right} y1={y} y2={y} className="gridline" />
                <text x={MARGIN.left - 8} y={y + 4} textAnchor="end" className="tick">
                  {formatBytes(v)}
                </text>
              </g>
            );
          })}
          {/* 柱 */}
          {data.map((d, i) => {
            const x0 = MARGIN.left + i * slot + (slot - groupW) / 2;
            let x = x0;
            const bars = [];
            if (visible.up) {
              bars.push(
                <path
                  key="up"
                  d={barPath(x, yOf(d.uploadedBytes), barW, (d.uploadedBytes / max) * plotH)}
                  className="bar-up"
                />,
              );
              x += barW + 2;
            }
            if (visible.down) {
              bars.push(
                <path
                  key="down"
                  d={barPath(x, yOf(d.downloadedBytes), barW, (d.downloadedBytes / max) * plotH)}
                  className="bar-down"
                />,
              );
            }
            return (
              <g key={d.day} opacity={hover == null || hover === i ? 1 : 0.45}>
                {bars}
              </g>
            );
          })}
          {/* x 轴标签（稀疏） */}
          {data.map((d, i) =>
            i % labelEvery === 0 ? (
              <text
                key={d.day}
                x={MARGIN.left + i * slot + slot / 2}
                y={H - 6}
                textAnchor="middle"
                className="tick"
              >
                {d.day.slice(5)}
              </text>
            ) : null,
          )}
          {/* 悬停命中区（整列） */}
          {data.map((d, i) => (
            <rect
              key={d.day}
              x={MARGIN.left + i * slot}
              y={MARGIN.top}
              width={slot}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hovered && hover != null && (
          <div
            className="chart-tooltip"
            style={{
              // chart-wrap 左右各 12px 内边距，百分比按 svg 实际宽度换算
              left: `calc(12px + ${((MARGIN.left + hover * slot + slot / 2) / W) * 100} * (100% - 24px) / 100)`,
              transform: `translateX(${hover > data.length / 2 ? "-100%" : "0"})`,
            }}
          >
            <div className="muted">{hovered.day}</div>
            {visible.up && (
              <div>
                <span className="dot up" /> 上传 {formatBytes(hovered.uploadedBytes)}
              </div>
            )}
            {visible.down && (
              <div>
                <span className="dot down" /> 下载 {formatBytes(hovered.downloadedBytes)}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
