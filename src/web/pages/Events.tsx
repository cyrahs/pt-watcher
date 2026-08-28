import { useEffect, useState } from "react";
import { api, formatRelative, type EventRow } from "../api";

const TYPE_CLS: Record<string, string> = {
  added: "good",
  completed: "good",
  free_extended: "good",
  retracked: "good",
  free_expired_stopped: "warn",
  clean_dry_run: "warn",
  untracked: "warn",
  clean_skipped: "warn",
  clean_insufficient: "warn",
  discover_skipped: "warn",
  cleaned: "bad",
  manual_delete: "bad",
  removed_external: "muted",
  discover_error: "bad",
  clean_error: "bad",
  free_guard_error: "bad",
};

export function EventTable({ events }: { events: EventRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>内容</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="event-row">
              <td title={new Date(e.ts).toLocaleString()}>{formatRelative(e.ts)}</td>
              <td>
                <span className={`badge ${TYPE_CLS[e.type] ?? ""}`}>{e.type}</span>
              </td>
              <td className="msg">{e.message}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                暂无事件
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Events() {
  const [events, setEvents] = useState<EventRow[]>([]);
  useEffect(() => {
    const load = () => api.events(200).then(setEvents).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  return <EventTable events={events} />;
}
