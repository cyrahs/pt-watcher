import { describe, expect, test } from "bun:test";
import { api } from "./routes";
import { endpointDocs } from "./docs";

describe("接口索引", () => {
  test("与实际注册的路由一一对应", () => {
    const registered = [...new Set(api.routes.map((r) => `${r.method} ${r.path}`))].sort();
    const documented = endpointDocs.map((d) => `${d.method} ${d.path}`).sort();
    expect(documented).toEqual(registered);
  });
});
