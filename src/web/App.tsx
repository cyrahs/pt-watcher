import { useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Torrents } from "./pages/Torrents";
import { Events } from "./pages/Events";
import { Settings } from "./pages/Settings";

const PAGES = [
  { key: "dashboard", label: "概览", component: Dashboard },
  { key: "torrents", label: "种子", component: Torrents },
  { key: "events", label: "事件", component: Events },
  { key: "settings", label: "设置", component: Settings },
] as const;

export function App() {
  const [page, setPage] = useState<string>("dashboard");
  const Current = PAGES.find((p) => p.key === page)?.component ?? Dashboard;
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="logo">
            <img src="/favicon.svg" alt="" />
            pt-watcher
          </div>
          <nav>
            {PAGES.map((p) => (
              <button
                key={p.key}
                className={page === p.key ? "active" : ""}
                onClick={() => setPage(p.key)}
              >
                {p.label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main>
        <Current />
      </main>
    </>
  );
}
