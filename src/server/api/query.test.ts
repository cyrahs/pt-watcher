import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import {
  escapeLike,
  parseBool,
  parseEnum,
  parseIdList,
  parseLimit,
  parseList,
  parseOffset,
  parseTime,
  parseTorrentRef,
} from "./query";

function expect400(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HTTPException);
    expect((e as HTTPException).status).toBe(400);
    return;
  }
  throw new Error("expected HTTPException(400)");
}

describe("parseLimit", () => {
  test("缺省用默认值", () => {
    expect(parseLimit(undefined, 100, 500)).toBe(100);
    expect(parseLimit("", 100, 500)).toBe(100);
  });

  test("超过上限截断", () => {
    expect(parseLimit("9999", 100, 500)).toBe(500);
  });

  test("非正整数报 400", () => {
    expect400(() => parseLimit("0", 100, 500));
    expect400(() => parseLimit("-1", 100, 500));
    expect400(() => parseLimit("1.5", 100, 500));
    expect400(() => parseLimit("abc", 100, 500));
  });
});

describe("parseOffset", () => {
  test("缺省为 0，负数报 400", () => {
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset("20")).toBe(20);
    expect400(() => parseOffset("-5"));
  });
});

describe("parseTime", () => {
  const now = new Date("2026-09-24T12:00:00Z");

  test("相对时长按 now 往前推", () => {
    expect(parseTime("30m", now)?.toISOString()).toBe("2026-09-24T11:30:00.000Z");
    expect(parseTime("24h", now)?.toISOString()).toBe("2026-09-23T12:00:00.000Z");
    expect(parseTime("7d", now)?.toISOString()).toBe("2026-09-17T12:00:00.000Z");
  });

  test("ISO 8601 原样解析", () => {
    expect(parseTime("2026-09-01T00:00:00Z", now)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseTime("2026-09-01", now)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  test("缺省返回 undefined", () => {
    expect(parseTime(undefined, now)).toBeUndefined();
  });

  test("宽松格式与非法值报 400", () => {
    expect400(() => parseTime("2026", now));
    expect400(() => parseTime("yesterday", now));
    expect400(() => parseTime("2026-13-45T00:00:00Z", now));
    expect400(() => parseTime("5w", now));
  });
});

describe("parseList / parseIdList", () => {
  test("逗号分隔并去空白", () => {
    expect(parseList("a, b,,c ")).toEqual(["a", "b", "c"]);
  });

  test("缺省或全空视为不过滤", () => {
    expect(parseList(undefined)).toBeUndefined();
    expect(parseList(" , ")).toBeUndefined();
  });

  test("id 列表逐项校验", () => {
    expect(parseIdList("torrentId", "1,2,3")).toEqual([1, 2, 3]);
    expect400(() => parseIdList("torrentId", "1,x"));
  });
});

describe("parseEnum / parseBool", () => {
  test("枚举外取值报 400", () => {
    expect(parseEnum("order", undefined, ["asc", "desc"] as const, "desc")).toBe("desc");
    expect(parseEnum("order", "asc", ["asc", "desc"] as const, "desc")).toBe("asc");
    expect400(() => parseEnum("order", "up", ["asc", "desc"] as const, "desc"));
  });

  test("布尔接受 true/false/1/0", () => {
    expect(parseBool("dryRun", "true")).toBe(true);
    expect(parseBool("dryRun", "0")).toBe(false);
    expect(parseBool("dryRun", undefined)).toBeUndefined();
    expect400(() => parseBool("dryRun", "yes"));
  });
});

describe("escapeLike", () => {
  test("转义 LIKE 通配符与反斜杠", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });
});

describe("parseTorrentRef", () => {
  test("数字为 id", () => {
    expect(parseTorrentRef("42")).toEqual({ id: 42 });
  });

  test("infohash 统一小写", () => {
    const h = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    expect(parseTorrentRef(h)).toEqual({ infoHash: h.toLowerCase() });
    expect(parseTorrentRef("a".repeat(64))).toEqual({ infoHash: "a".repeat(64) });
  });

  test("其他形式报 400", () => {
    expect400(() => parseTorrentRef("0"));
    expect400(() => parseTorrentRef("abc"));
    expect400(() => parseTorrentRef("a".repeat(41)));
  });
});
