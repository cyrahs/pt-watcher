import { useMemo, useState } from "react";
import { formatBytes, type TrafficDay } from "../api";

const W = 860;
const H = 220;
const MARGIN = { top: 10, right: 8, bottom: 22, left: 56 };

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
  const [view, setView] = useState<"chart" | "table">("chart");

  const data = useMemo(() => fillDays(daily, days), [daily, days]);
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.uploadedBytes, d.downloadedBytes))));

  const plotW = W - MARGIN.left - MARGIN.right;
  const plotH = H - MARGIN.top - MARGIN.bottom;
  const slot = plotW / data.length;
  const barW = Math.max(2, (slot - 6) / 2);
  const yOf = (v: number) => MARGIN.top + plotH * (1 - v / max);
  const labelEvery = Math.ceil(data.length / 6);

  if (view === "table") {
    return (
      <>
        <ChartHeader view={view} setView={setView} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>上传</th>
                <th>下载</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{formatBytes(d.uploadedBytes)}</td>
                  <td>{formatBytes(d.downloadedBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  const hovered = hover != null ? data[hover] : null;

  return (
    <>
      <ChartHeader view={view} setView={setView} />
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
            const x0 = MARGIN.left + i * slot + (slot - barW * 2 - 2) / 2;
            const upH = (d.uploadedBytes / max) * plotH;
            const downH = (d.downloadedBytes / max) * plotH;
            return (
              <g key={d.day} opacity={hover == null || hover === i ? 1 : 0.45}>
                <path d={barPath(x0, yOf(d.uploadedBytes), barW, upH)} className="bar-up" />
                <path d={barPath(x0 + barW + 2, yOf(d.downloadedBytes), barW, downH)} className="bar-down" />
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
            <div>
              <span className="dot up" /> 上传 {formatBytes(hovered.uploadedBytes)}
            </div>
            <div>
              <span className="dot down" /> 下载 {formatBytes(hovered.downloadedBytes)}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ChartHeader({
  view,
  setView,
}: {
  view: "chart" | "table";
  setView: (v: "chart" | "table") => void;
}) {
  return (
    <div className="chart-header">
      <div className="chart-legend">
        <span>
          <span className="dot up" /> 上传
        </span>
        <span>
          <span className="dot down" /> 下载
        </span>
      </div>
      <div className="filters" style={{ margin: 0 }}>
        <button className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>
          图表
        </button>
        <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
          表格
        </button>
      </div>
    </div>
  );
}
