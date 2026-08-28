import { useEffect, useState } from "react";
import { api, type PtCategory } from "../api";

interface FieldDef {
  key: string;
  label: string;
  type: "number" | "boolean" | "list" | "text" | "password" | "categories";
}

const GROUP_LABELS: Record<string, string> = {
  adult: "成人",
  movie: "电影",
  music: "音乐",
  tvshow: "剧集",
  anime: "动漫",
  normal: "综合",
};

function CategoryPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [cats, setCats] = useState<PtCategory[] | null>(null);

  useEffect(() => {
    api.ptCategories().then(setCats).catch(() => setCats([]));
  }, []);

  if (cats === null) return <div className="muted">分类加载中…</div>;
  if (cats.length === 0) {
    // 站点 API 未配置时退化为手填 id
    return (
      <input
        type="text"
        placeholder="分类 id，逗号分隔（站点 API 未配置，无法拉取列表）"
        value={selected.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }

  const groups = [...new Set(cats.map((c) => c.group))];
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div>
      <div className="muted" style={{ marginBottom: 8 }}>
        不勾选 = 不限分类（按下方搜索 mode 搜索）；勾选后只搜所选分类，mode 自动推导
      </div>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            {GROUP_LABELS[g] ?? g}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {cats
              .filter((c) => c.group === g)
              .map((c) => (
                <label
                  key={`${c.siteId}-${c.id}`}
                  className={`badge ${selected.includes(c.id) ? "" : "muted"}`}
                  style={{ cursor: "pointer", userSelect: "none" }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    style={{ display: "none" }}
                  />
                  {c.name}
                </label>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const GROUPS: { title: string; fields: FieldDef[]; test?: "mteam" | "qbit" }[] = [
  {
    title: "M-Team 连接",
    test: "mteam",
    fields: [
      { key: "mtApiKey", label: "API Key（控制台 → 实验室 → 存取令牌）", type: "password" },
      { key: "mtBaseUrl", label: "API 地址", type: "text" },
    ],
  },
  {
    title: "qBittorrent 连接",
    test: "qbit",
    fields: [
      { key: "qbitUrl", label: "WebUI 地址（如 http://qbittorrent:8080）", type: "text" },
      { key: "qbitApiKey", label: "API Key（需 qBittorrent ≥ 5.2，WebUI 设置中生成，形如 qbt_...）", type: "password" },
    ],
  },
  {
    title: "分类管理",
    fields: [
      { key: "managedCategories", label: "受管分类（逗号分隔）", type: "list" },
      { key: "incomingCategory", label: "新种子落入的分类", type: "text" },
      { key: "watcherTag", label: "标记 tag", type: "text" },
    ],
  },
  {
    title: "发现 free 种子",
    fields: [
      { key: "discoverEnabled", label: "启用自动发现", type: "boolean" },
      { key: "onlyTimeLimitedFree", label: "只收限时 free（排除长期 free 的巨型合集）", type: "boolean" },
      { key: "searchCategories", label: "限定分类", type: "categories" },
      { key: "searchModes", label: "搜索 mode（未限定分类时生效，逗号分隔: normal/movie/tvshow/adult/music）", type: "list" },
      { key: "minFreeHours", label: "最小剩余 free 时长（小时）", type: "number" },
      { key: "minSizeGB", label: "最小体积（GB，0=不限）", type: "number" },
      { key: "maxSizeGB", label: "最大体积（GB，0=不限）", type: "number" },
      { key: "maxAddPerRun", label: "每轮最多添加数", type: "number" },
    ],
  },
  {
    title: "空间清理",
    fields: [
      { key: "cleanEnabled", label: "启用自动清理", type: "boolean" },
      { key: "cleanDryRun", label: "dry-run 模式（只记录不真删）", type: "boolean" },
      { key: "freeSpaceThresholdGB", label: "磁盘剩余空间阈值（GB）", type: "number" },
      { key: "newTorrentProtectHours", label: "新种子保护期（小时）", type: "number" },
    ],
  },
  {
    title: "free 到期守卫",
    fields: [{ key: "freeStopLeadMinutes", label: "到期前提前停止（分钟）", type: "number" }],
  },
  {
    title: "流行度评分权重",
    fields: [
      { key: "weightUpload", label: "上传速度权重", type: "number" },
      { key: "weightDemand", label: "需求度权重（leech/seed）", type: "number" },
      { key: "weightRatio", label: "分享率权重", type: "number" },
      { key: "weightAge", label: "年龄权重", type: "number" },
      { key: "weightQbitPopularity", label: "qBit popularity 权重", type: "number" },
      { key: "ageHalfLifeDays", label: "年龄半衰期（天）", type: "number" },
    ],
  },
  {
    title: "任务间隔（秒）",
    fields: [
      { key: "discoverIntervalSec", label: "discover", type: "number" },
      { key: "freeGuardIntervalSec", label: "freeGuard", type: "number" },
      { key: "spaceCleanIntervalSec", label: "spaceClean", type: "number" },
      { key: "reconcileIntervalSec", label: "reconcile", type: "number" },
    ],
  },
];

type TestState = { status: "loading" } | { status: "ok" | "fail"; text: string };

export function Settings() {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<string, TestState>>({});

  useEffect(() => {
    api.settings().then(setValues).catch((e) => setError(String(e)));
  }, []);

  if (!values) return <div className="muted">{error || "加载中…"}</div>;

  const set = (key: string, v: unknown) => setValues({ ...values, [key]: v });

  const runTest = async (target: "mteam" | "qbit") => {
    setTests((t) => ({ ...t, [target]: { status: "loading" } }));
    const payload =
      target === "mteam"
        ? { mtApiKey: values.mtApiKey, mtBaseUrl: values.mtBaseUrl }
        : { qbitUrl: values.qbitUrl, qbitApiKey: values.qbitApiKey };
    try {
      const res = await api.testConnection(target, payload);
      setTests((t) => ({ ...t, [target]: { status: "ok", text: res.message } }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [target]: { status: "fail", text: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  const save = async () => {
    setMessage("");
    setError("");
    try {
      const saved = await api.saveSettings(values);
      setValues(saved);
      setMessage("已保存");
      setTimeout(() => setMessage(""), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      {GROUPS.map((g) => (
        <div className="section" key={g.title}>
          <h2>{g.title}</h2>
          <div className="card">
            <div className="form-grid">
              {g.fields.map((f) => {
                const v = values[f.key];
                if (f.type === "categories") {
                  return (
                    <div className="field" key={f.key} style={{ gridColumn: "1 / -1" }}>
                      <label>{f.label}</label>
                      <CategoryPicker
                        selected={Array.isArray(v) ? (v as string[]) : []}
                        onChange={(ids) => set(f.key, ids)}
                      />
                    </div>
                  );
                }
                if (f.type === "boolean") {
                  return (
                    <div className="field checkbox" key={f.key}>
                      <input
                        type="checkbox"
                        id={f.key}
                        checked={Boolean(v)}
                        onChange={(e) => set(f.key, e.target.checked)}
                      />
                      <label htmlFor={f.key}>{f.label}</label>
                    </div>
                  );
                }
                return (
                  <div className="field" key={f.key}>
                    <label htmlFor={f.key}>{f.label}</label>
                    <input
                      id={f.key}
                      type={f.type === "number" ? "number" : f.type === "password" ? "password" : "text"}
                      autoComplete={f.type === "password" ? "new-password" : undefined}
                      step="any"
                      value={
                        f.type === "list" ? (Array.isArray(v) ? v.join(", ") : "") : String(v ?? "")
                      }
                      onChange={(e) => {
                        if (f.type === "number") set(f.key, Number(e.target.value));
                        else if (f.type === "list")
                          set(
                            f.key,
                            e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          );
                        else set(f.key, e.target.value);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {g.test && (
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  className="action"
                  onClick={() => runTest(g.test!)}
                  disabled={tests[g.test]?.status === "loading"}
                >
                  {tests[g.test]?.status === "loading" ? "测试中…" : "测试连接"}
                </button>
                {(() => {
                  const t = tests[g.test];
                  if (!t || t.status === "loading") return null;
                  return (
                    <span style={{ color: t.status === "ok" ? "var(--good)" : "var(--bad)" }}>
                      {t.text}
                    </span>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="section">
        <button className="primary" onClick={save}>
          保存设置
        </button>
        {message && <span style={{ marginLeft: 12, color: "var(--good)" }}>{message}</span>}
      </div>
    </>
  );
}
