import { useEffect, useState } from "react";
import { api, formatBytes, formatRelative, type EventRow, type Status, type TorrentRow } from "../api";
import { EventTable } from "./Events";

export function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [torrents, setTorrents] = useState<TorrentRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    api.status().then(setStatus).catch((e) => setError(String(e)));
    api.torrents().then(setTorrents).catch(() => {});
    api.events(15).then(setEvents).catch(() => {});
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

  return (
    <>
      {error && <div className="error-banner">状态加载失败: {error}</div>}
      <div className="cards">
        <div className="card">
          <h3>磁盘剩余空间</h3>
          <div className="big" style={{ color: spaceOk ? "var(--good)" : "var(--bad)" }}>
            {formatBytes(free)}
          </div>
          <div className="sub">清理阈值 {formatBytes(threshold)}</div>
          <div className="gauge">
            <div
              style={{
                width: free != null ? `${Math.min((free / (threshold * 2)) * 100, 100)}%` : "0%",
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
          <div className="sub">{status?.qbit.url || "设置 QBIT_URL 环境变量"}</div>
        </div>
        <div className="card">
          <h3>M-Team API</h3>
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
          <div className="sub">{status?.mteam.configured ? "" : "设置 MT_API_KEY 环境变量"}</div>
        </div>
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
