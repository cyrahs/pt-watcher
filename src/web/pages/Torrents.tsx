import { useEffect, useMemo, useState } from "react";
import { api, formatBytes, formatRelative, type TorrentRow } from "../api";

const STATE_LABELS: Record<string, { label: string; cls: string }> = {
  downloading: { label: "下载中", cls: "" },
  completed: { label: "做种中", cls: "good" },
  stopped_free_expired: { label: "free到期已停", cls: "warn" },
  deleted_by_cleanup: { label: "已清理", cls: "bad" },
  removed_external: { label: "外部已删", cls: "muted" },
  untracked: { label: "已脱管", cls: "muted" },
};

const FILTERS = [
  { key: "active", label: "跟踪中" },
  { key: "all", label: "全部" },
  { key: "downloading", label: "下载中" },
  { key: "completed", label: "做种中" },
  { key: "stopped_free_expired", label: "free到期已停" },
  { key: "untracked", label: "已脱管" },
  { key: "deleted_by_cleanup", label: "已清理" },
];

const ACTIVE_STATES = ["downloading", "completed", "stopped_free_expired"];

function freeRemaining(t: TorrentRow): string {
  if (t.freeEndTime === null) {
    // 有站点信息但无到期时间 = 不限时 free；纯收养（无站点信息）的显示 -
    return t.siteId && t.state === "downloading" ? "不限时" : "-";
  }
  const ms = new Date(t.freeEndTime).getTime() - Date.now();
  if (ms <= 0) return "已到期";
  return formatRelative(t.freeEndTime).replace("后", "");
}

export function Torrents() {
  const [rows, setRows] = useState<TorrentRow[]>([]);
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState("");

  const load = () => api.torrents().then(setRows).catch((e) => setError(String(e)));
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const shown = useMemo(() => {
    let list = rows;
    if (filter === "active") list = rows.filter((r) => ACTIVE_STATES.includes(r.state));
    else if (filter !== "all") list = rows.filter((r) => r.state === filter);
    // 跟踪中按评分升序（最先被清理的排前面），其它按时间倒序
    if (filter === "active") return [...list].sort((a, b) => a.score - b.score);
    return list;
  }, [rows, filter]);

  const act = async (id: number, action: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      await api.torrentAction(id, action);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      {error && (
        <div className="error-banner" onClick={() => setError("")}>
          {error}（点击关闭）
        </div>
      )}
      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? "active" : ""}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>来源</th>
              <th>状态</th>
              <th className="num">大小</th>
              <th>进度</th>
              <th className="num">free 剩余</th>
              <th className="num">评分</th>
              <th className="num">分享率</th>
              <th>分类</th>
              <th className="actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => {
              const st = STATE_LABELS[t.state] ?? { label: t.state, cls: "" };
              const isActive = ACTIVE_STATES.includes(t.state);
              return (
                <tr key={t.id}>
                  <td className="name" title={t.name}>
                    {t.name}
                  </td>
                  <td>
                    {t.addedByWatcher ? (
                      <span className="badge">自动添加</span>
                    ) : (
                      <span className="badge muted">外部收养</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                  </td>
                  <td className="num">{formatBytes(t.sizeBytes)}</td>
                  <td>
                    <div className="progress" title={`${(t.progress * 100).toFixed(1)}%`}>
                      <div style={{ width: `${t.progress * 100}%` }} />
                    </div>
                  </td>
                  <td className="num">{freeRemaining(t)}</td>
                  <td className="num">{isActive ? t.score.toFixed(3) : "-"}</td>
                  <td className="num">{t.ratio.toFixed(2)}</td>
                  <td>{t.category}</td>
                  <td className="actions">
                    {isActive && (
                      <>
                        {t.state === "stopped_free_expired" || t.state === "downloading" ? (
                          t.state === "downloading" ? (
                            <button className="action" onClick={() => act(t.id, "stop")}>
                              停止
                            </button>
                          ) : (
                            <button className="action" onClick={() => act(t.id, "start")}>
                              恢复
                            </button>
                          )
                        ) : null}
                        <button
                          className="action danger"
                          onClick={() => act(t.id, "delete", `确认删除种子及文件？\n${t.name}`)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={10} className="muted empty">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
