import { useEffect, useMemo, useState } from "react";
import { api, formatBytes, formatRelative, type PlanResponse, type TorrentRow } from "../api";

const STATE_LABELS: Record<string, { label: string; cls: string }> = {
  downloading: { label: "下载中", cls: "" },
  completed: { label: "做种中", cls: "good" },
  stopped_free_expired: { label: "free到期·停止下载", cls: "warn" },
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

const PRESSURE_LABELS: Record<string, { label: string; cls: string }> = {
  HEALTHY: { label: "空间健康", cls: "good" },
  PRESSURE: { label: "空间压力", cls: "warn" },
  RECLAIMING: { label: "清理中", cls: "warn" },
  BLOCKED: { label: "清理受阻", cls: "bad" },
  UNKNOWN: { label: "空间未知", cls: "muted" },
};

/** 清理计划面板：展示后端实际计划（真实/演练同一规划器），不再由前端按分数自行推断删除顺序 */
function PlanPanel({ plan }: { plan: PlanResponse | null }) {
  if (!plan) return null;
  const st = PRESSURE_LABELS[plan.pressure.state] ?? { label: plan.pressure.state, cls: "" };
  const showPlan =
    plan.pressure.state !== "HEALTHY" && plan.pressure.state !== "UNKNOWN" && plan.latest !== null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>空间清理</h3>
        <span className={`badge ${st.cls}`}>{st.label}</span>
        {plan.pressure.blockedReason && (
          <span className="badge bad">{plan.pressure.blockedReason}</span>
        )}
        {showPlan && plan.latest!.dryRun && <span className="badge warn">演练模式，不会执行</span>}
      </div>
      {plan.pressure.state === "HEALTHY" && (
        <div className="muted" style={{ marginTop: 8 }}>
          当前无需清理（实际剩余空间高于阈值时不会执行任何策略性删除）
        </div>
      )}
      {plan.pressure.state === "UNKNOWN" && (
        <div className="muted" style={{ marginTop: 8 }}>
          空间观测失效：不会据未知值删除，已暂停新增下载增长
        </div>
      )}
      {showPlan && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            缺口 {formatBytes(plan.latest!.needBytes)} · 策略 {plan.latest!.plan.strategy} · 预计释放{" "}
            {formatBytes(plan.latest!.plan.expectedTotalReclaim)} · 计划时间{" "}
            {formatRelative(plan.latest!.createdAt)}
            {plan.latest!.plan.usedProtected ? " · 已降级动用保护期候选" : ""}
          </div>
          {plan.latest!.plan.chosen.length > 0 ? (
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {plan.latest!.plan.chosen.map((c) => (
                <li key={c.id}>
                  {c.name}
                  <span className="muted">（预计释放 {formatBytes(c.reclaimableBytes)}）</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="muted">{plan.latest!.plan.reason ?? plan.latest!.status}</div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState("");

  const load = () => {
    api.torrents().then(setRows).catch((e) => setError(String(e)));
    api.plan().then(setPlan).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  // 删除顺序由后端计划面板展示；列表统一按时间倒序，不再用分数模拟清理顺序
  const shown = useMemo(() => {
    if (filter === "active") return rows.filter((r) => ACTIVE_STATES.includes(r.state));
    if (filter !== "all") return rows.filter((r) => r.state === filter);
    return rows;
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
      <PlanPanel plan={plan} />
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
              <th className="num" title="统一预测窗口内的预计上传（近期速率外推代理，非精确长期预测）">预计上传</th>
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
                  <td
                    className="num"
                    title={
                      t.predictionKind
                        ? `预测类型 ${t.predictionKind} · legacy 评分 ${t.score.toFixed(3)} · 预测于 ${formatRelative(t.predictedAt)}`
                        : undefined
                    }
                  >
                    {isActive && t.expectedUploadBytes != null
                      ? formatBytes(t.expectedUploadBytes)
                      : "-"}
                  </td>
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
