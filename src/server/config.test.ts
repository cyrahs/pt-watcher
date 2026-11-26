import { describe, expect, test } from "bun:test";
import {
  decodeStoredSecrets,
  decryptSecret,
  diffSettings,
  encodeSecretsForStorage,
  encryptSecret,
  isAllowedMteamBaseUrl,
  mergeSettingsPatch,
  publicSettings,
  REDACTED,
  SettingsError,
  settingsSchema,
} from "./config";

const base = settingsSchema.parse({ mtApiKey: "old-key", qbitApiKey: "q" });

describe("settingsSchema 默认值", () => {
  test("基于线上数据调整的默认值（IMPLEMENTATION_NOTES §7）", () => {
    const s = settingsSchema.parse({});
    expect(s.uploadEmaHalfLifeSec).toBe(21600);
    expect(s.newTorrentProtectHours).toBe(24);
    expect(s.freeExpiredNoDataPurgeHours).toBe(24);
  });

  test("已保存的配置值优先于代码默认值", () => {
    expect(settingsSchema.parse({ uploadEmaHalfLifeSec: 233 }).uploadEmaHalfLifeSec).toBe(233);
  });
});

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

describe("凭据保护", () => {
  const secret = "test-secret-key";

  test("加密后可解密，密文不含明文，每次 IV 不同", () => {
    const a = encryptSecret("my-api-key", secret);
    const b = encryptSecret("my-api-key", secret);
    expect(a.startsWith("enc:v1:")).toBe(true);
    expect(a).not.toContain("my-api-key");
    expect(a).not.toBe(b);
    expect(decryptSecret(a, secret)).toBe("my-api-key");
  });

  test("密钥不对时解密失败，decodeStoredSecrets 视为未配置", () => {
    const stored = encodeSecretsForStorage(base, secret);
    expect(stored.mtApiKey).not.toBe("old-key");
    expect(() => decryptSecret(stored.mtApiKey as string, "wrong")).toThrow();
    expect(decodeStoredSecrets(stored, "wrong").mtApiKey).toBe("");
    expect(decodeStoredSecrets(stored, secret)).toMatchObject({ mtApiKey: "old-key", qbitApiKey: "q" });
  });

  test("没有密钥时明文存储（本地开发），明文值原样读回", () => {
    expect(encodeSecretsForStorage(base, "").mtApiKey).toBe("old-key");
    expect(decodeStoredSecrets({ mtApiKey: "plain" }, secret).mtApiKey).toBe("plain");
  });

  test("对外返回的配置不含凭据", () => {
    const pub = publicSettings(base);
    expect(pub.mtApiKey).toBe(REDACTED);
    expect(pub.qbitApiKey).toBe(REDACTED);
    expect(JSON.stringify(pub)).not.toContain("old-key");
    expect(publicSettings(settingsSchema.parse({})).mtApiKey).toBe("");
  });

  test("PUT 传回占位符或空串保持原凭据，填写新值才替换", () => {
    expect(mergeSettingsPatch(base, { mtApiKey: REDACTED, qbitApiKey: "" })).toMatchObject({
      mtApiKey: "old-key",
      qbitApiKey: "q",
    });
    expect(mergeSettingsPatch(base, { mtApiKey: "new-key" }).mtApiKey).toBe("new-key");
  });

  test("M-Team 地址只允许官方域名", () => {
    expect(isAllowedMteamBaseUrl("https://api.m-team.cc/api")).toBe(true);
    expect(isAllowedMteamBaseUrl("https://api.m-team.io/api")).toBe(true);
    expect(isAllowedMteamBaseUrl("http://api.m-team.cc/api")).toBe(false);
    expect(isAllowedMteamBaseUrl("https://m-team.cc.evil.com/api")).toBe(false);
    expect(isAllowedMteamBaseUrl("https://evil.com/?x=m-team.cc")).toBe(false);
    expect(() => mergeSettingsPatch(base, { mtBaseUrl: "https://evil.com/api" })).toThrow(SettingsError);
  });

  test("改 qBittorrent 地址必须同时填写新 key", () => {
    const withUrl = { ...base, qbitUrl: "http://qb:8080" };
    expect(() => mergeSettingsPatch(withUrl, { qbitUrl: "http://evil:8080" })).toThrow(SettingsError);
    expect(() => mergeSettingsPatch(withUrl, { qbitUrl: "http://evil:8080", qbitApiKey: REDACTED })).toThrow(
      SettingsError,
    );
    expect(mergeSettingsPatch(withUrl, { qbitUrl: "http://qb2:8080", qbitApiKey: "k2" })).toMatchObject({
      qbitUrl: "http://qb2:8080",
      qbitApiKey: "k2",
    });
    expect(mergeSettingsPatch(withUrl, { qbitUrl: "http://qb:8080" }).qbitApiKey).toBe("q");
  });
});
