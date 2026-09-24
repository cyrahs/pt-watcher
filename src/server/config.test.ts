import { describe, expect, test } from "bun:test";
import { diffSettings, settingsSchema } from "./config";

const base = settingsSchema.parse({ mtApiKey: "old-key", qbitApiKey: "q" });

describe("diffSettings", () => {
  test("只列出变化的字段，记录前后值", () => {
    const after = { ...base, freeSpaceThresholdGB: 150, cleanDryRun: false };
    expect(diffSettings(base, after)).toEqual({
      freeSpaceThresholdGB: { from: 100, to: 150 },
      cleanDryRun: { from: true, to: false },
    });
  });

  test("数组按内容比较", () => {
    expect(diffSettings(base, { ...base, managedCategories: ["pt-watcher"] })).toEqual({});
    expect(diffSettings(base, { ...base, managedCategories: ["pt-watcher", "movies"] })).toEqual({
      managedCategories: { from: ["pt-watcher"], to: ["pt-watcher", "movies"] },
    });
  });

  test("凭据字段只标记修改，不记录值", () => {
    const diff = diffSettings(base, { ...base, mtApiKey: "new-key" });
    expect(diff).toEqual({ mtApiKey: { from: "<redacted>", to: "<redacted>" } });
    expect(JSON.stringify(diff)).not.toContain("old-key");
    expect(JSON.stringify(diff)).not.toContain("new-key");
  });

  test("无变化返回空对象", () => {
    expect(diffSettings(base, { ...base })).toEqual({});
  });
});
