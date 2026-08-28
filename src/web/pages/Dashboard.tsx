import { useEffect, useState } from "react";
import {
  api,
  formatBytes,
  formatRelative,
  type EventRow,
  type SiteUserStats,
  type Status,
  type TorrentRow,
  type TrafficStats,
} from "../api";
import { EventTable } from "./Events";
import { TrafficChart } from "../components/TrafficChart";

const TRAFFIC_DAYS = 30;

function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [torrents, setTorrents] = useState<TorrentRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [traffic, setTraffic] = useState<TrafficStats | null>(null);
  const [siteStats, setSiteStats] = useState<SiteUserStats[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    api.status().then(setStatus).catch((e) => setError(String(e)));
    api.torrents().then(setTorrents).catch(() => {});
    api.events(15).then(setEvents).catch(() => {});
    api.trafficStats(TRAFFIC_DAYS).then(setTraffic).catch(() => {});
    api.siteStats().then(setSiteStats).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const active = torrents.filter((t) =>
    ["downloading", "completed", "stopped_free_expired"].includes(t.state),
  );
  const downloading = active.filter((t) => t.state === "downloading").length;
  const stopped = active.filter((t) => t.state === "stopped_free_expired").length;

  const free = status?.freeSpaceBytes ?? null;
  const threshold = status?.freeSpaceThresholdBytes ?? 0;
  const spaceOk = free != null && free >= threshold;
  const total = status?.diskTotalBytes ?? null;
  const usedRatio = free != null && total != null && total > 0 ? Math.min(Math.max(1 - free / total, 0), 1) : null;

  const today = traffic?.daily.find((d) => d.day === localDayKey());
  const mt = siteStats.find((s) => s.siteId === "mteam") ?? null;

  return (
    <>
      {error && <div className="error-banner">状态加载失败: {error}</div>}
      <div className="cards">
        <div className="card">
          <h3>磁盘剩余空间</h3>
          <div className="big" style={{ color: spaceOk ? "var(--good)" : "var(--bad)" }}>
            {formatBytes(free)}
            {total != null && (
              <span style={{ color: "var(--muted)", fontWeight: 400 }}>{` / ${formatBytes(total)}`}</span>
            )}
          </div>
          <div className="sub">
            {usedRatio != null ? `受管种子已用 ${(usedRatio * 100).toFixed(0)}%` : ""}
          </div>
          <div className="gauge">
            <div
              style={{
                width: usedRatio != null ? `${usedRatio * 100}%` : "0%",
                background: spaceOk ? "var(--good)" : "var(--bad)",
              }}
            />
          </div>
        </div>
        <div className="card">
          <h3>跟踪中种子</h3>
          <div className="big">{active.length}</div>
          <div className="sub">
            下载中 {downloading} · free到期已停 {stopped}
          </div>
        </div>
        <div className="card">
          <h3>qBittorrent</h3>
          <div className="big">
            {status ? (
              status.qbit.connected ? (
                <span className="badge good">已连接</span>
              ) : status.qbit.configured ? (
                <span className="badge bad">连接失败</span>
              ) : (
                <span className="badge warn">未配置</span>
              )
            ) : (
              "…"
            )}
          </div>
          <div className="sub">{status && !status.qbit.configured ? "请在设置页填写 WebUI 地址" : ""}</div>
        </div>
      </div>
      <div className="cards">
        <div className="card">
          <h3>累计流量（pt-watcher 受管种子）</h3>
          <div className="big">
            <span className="dot up" title="上传" />
            {formatBytes(traffic?.totals.uploadedBytes ?? null)}{" "}
            <span className="dot down" title="下载" />
            {formatBytes(traffic?.totals.downloadedBytes ?? null)}
          </div>
          <div className="sub">
            今日 上传 {formatBytes(today?.uploadedBytes ?? 0)} · 下载 {formatBytes(today?.downloadedBytes ?? 0)}
          </div>
        </div>
        <div className="card">
          <h3>M-Team 账号{mt?.username ? ` · ${mt.username}` : ""}</h3>
          {mt ? (
            <>
              <div className="big">
                分享率 {mt.shareRate == null ? "∞" : mt.shareRate.toFixed(2)}
              </div>
              <div className="sub">
                <span className="dot up" title="上传" />
                {formatBytes(mt.uploadedBytes)} · <span className="dot down" title="下载" />
                {formatBytes(mt.downloadedBytes)}
              </div>
            </>
          ) : (
            <>
              <div className="big">
                {status ? (
                  status.mteam.configured ? (
                    <span className="badge good">已配置</span>
                  ) : (
                    <span className="badge warn">未配置</span>
                  )
                ) : (
                  "…"
                )}
              </div>
              <div className="sub">{status?.mteam.configured ? "" : "请在设置页填写 API Key"}</div>
            </>
          )}
        </div>
      </div>

      <div className="section">
        <h2>流量统计（近 {TRAFFIC_DAYS} 天）</h2>
        <TrafficChart daily={traffic?.daily ?? []} days={TRAFFIC_DAYS} />
      </div>

      <div className="section">
        <h2>后台任务</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>上次运行</th>
                <th>错误</th>
                <th className="actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {status?.jobs.map((j) => (
                <tr key={j.name}>
                  <td>{j.name}</td>
                  <td>
                    {j.running ? (
                      <span className="badge">运行中</span>
                    ) : (
                      <span className="badge muted">空闲</span>
                    )}
                  </td>
                  <td>{formatRelative(j.lastRunAt)}</td>
                  <td className="err" title={j.lastError ?? undefined}>
                    {j.lastError ?? ""}
                  </td>
                  <td className="actions">
                    <button
                      className="action"
                      onClick={() => api.runJob(j.name).then(() => setTimeout(load, 500))}
                    >
                      立即运行
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <h2>最近事件</h2>
        <EventTable events={events} />
      </div>
    </>
  );
}
