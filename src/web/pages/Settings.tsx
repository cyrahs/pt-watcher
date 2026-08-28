import { useEffect, useState } from "react";
import { api } from "../api";

interface FieldDef {
  key: string;
  label: string;
  type: "number" | "boolean" | "list" | "text";
}

const GROUPS: { title: string; fields: FieldDef[] }[] = [
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
      { key: "searchModes", label: "搜索 mode（逗号分隔: normal/movie/tvshow/adult/music）", type: "list" },
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

export function Settings() {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then(setValues).catch((e) => setError(String(e)));
  }, []);

  if (!values) return <div className="muted">{error || "加载中…"}</div>;

  const set = (key: string, v: unknown) => setValues({ ...values, [key]: v });

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
                      type={f.type === "number" ? "number" : "text"}
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
