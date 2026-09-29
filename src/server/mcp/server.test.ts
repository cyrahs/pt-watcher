import { describe, expect, test } from "bun:test";
import { api } from "../api/routes";
import { handleMcpRequest, tools, type ApiApp } from "./server";

/** 记录收到的请求，按路径返回预设响应 */
function stubApi(responses: Record<string, { status?: number; body: unknown }> = {}) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const app: ApiApp = {
    async request(input, init) {
      calls.push({ method: init?.method ?? "GET", url: input, body: init?.body as string | undefined });
      const r = responses[input.split("?")[0]!] ?? { body: { ok: true } };
      return Response.json(r.body, { status: r.status ?? 200 });
    },
  };
  return { app, calls };
}

let nextId = 1;
async function rpc(app: ApiApp, method: string, params?: unknown) {
  const res = await handleMcpRequest(
    new Request("http://pt-watcher/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    app,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: any; error?: any };
}

const callTool = (app: ApiApp, name: string, args: unknown = {}) =>
  rpc(app, "tools/call", { name, arguments: args }).then((r) => r.result);

describe("MCP 工具", () => {
  test("每个工具都指向实际注册的 /api 路由", () => {
    const registered = new Set(api.routes.map((r) => `${r.method} ${r.path}`));
    for (const t of tools) expect(registered).toContain(`${t.method} ${t.route}`);
  });

  test("initialize 与 tools/list", async () => {
    const { app } = stubApi();
    const init = await rpc(app, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result.serverInfo.name).toBe("pt-watcher");
    expect(init.result.capabilities.tools).toBeDefined();

    const list = await rpc(app, "tools/list");
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(tools.map((t) => t.name).sort());
    const action = list.result.tools.find((t: { name: string }) => t.name === "torrent_action");
    expect(action.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  test("参数转成 /api 查询串，数组逗号拼接，MCP 默认 limit", async () => {
    const { app, calls } = stubApi();
    const r = await callTool(app, "list_torrents", { states: ["downloading", "completed"], q: "a b" });
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ method: "GET", url: "/torrents?state=downloading%2Ccompleted&q=a+b&limit=50" });

    await callTool(app, "list_events", { since: "2026-09-01T00:00:00+08:00", cursor: 10 });
    expect(new URL(calls[1]!.url, "http://x").searchParams.get("since")).toBe("2026-09-01T00:00:00+08:00");

    await callTool(app, "torrent_action", { id: 7, action: "stop" });
    expect(calls[2]).toMatchObject({ method: "POST", url: "/torrents/7/stop" });
  });

  test("非 2xx 以 isError 返回错误信息", async () => {
    const { app } = stubApi({ "/torrents/abc": { status: 400, body: { error: "invalid ref" } } });
    const r = await callTool(app, "get_torrent", { ref: "abc" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("HTTP 400: invalid ref");
  });

  test("参数不合法时不调用 /api", async () => {
    const { app, calls } = stubApi();
    const r = await callTool(app, "run_job", { name: "nope" });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("配置读写脱敏凭据，且不能经 MCP 修改凭据", async () => {
    const settings = { mtApiKey: "secret", qbitApiKey: "", cleanDryRun: true };
    const { app, calls } = stubApi({ "/settings": { body: settings } });
    const got = JSON.parse((await callTool(app, "get_settings")).content[0].text);
    expect(got).toEqual({ mtApiKey: "<redacted>", qbitApiKey: "", cleanDryRun: true });

    const updated = await callTool(app, "update_settings", { changes: { cleanDryRun: false } });
    expect(JSON.parse(updated.content[0].text).mtApiKey).toBe("<redacted>");
    expect(calls[1]).toMatchObject({ method: "PUT", url: "/settings", body: '{"cleanDryRun":false}' });

    const denied = await callTool(app, "update_settings", { changes: { mtApiKey: "x" } });
    expect(denied.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("只支持 POST", async () => {
    const { app } = stubApi();
    const res = await handleMcpRequest(new Request("http://pt-watcher/mcp"), app);
    expect(res.status).toBe(405);
  });
});
