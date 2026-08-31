import { describe, expect, test } from "bun:test";
import { scoreBatch, type ScoreInput } from "./popularity";
import { settingsSchema } from "../config";

const s = settingsSchema.parse({});

function item(partial: Partial<ScoreInput>): ScoreInput {
  return {
    upEma: 0,
    seeders: 0,
    leechers: 0,
    ratio: 0,
    ageDays: 30,
    qbitPopularity: 0,
    ...partial,
  };
}

describe("scoreBatch", () => {
  test("高上传速度的种子评分更高", () => {
    const hot = item({ upEma: 1_000_000 });
    const cold = item({ upEma: 0 });
    const scores = scoreBatch([hot, cold], s);
    expect(scores.get(hot)!).toBeGreaterThan(scores.get(cold)!);
  });

  test("需求高（leechers 多、seeders 少）的评分更高", () => {
    const wanted = item({ seeders: 2, leechers: 50 });
    const saturated = item({ seeders: 200, leechers: 1 });
    const scores = scoreBatch([wanted, saturated], s);
    expect(scores.get(wanted)!).toBeGreaterThan(scores.get(saturated)!);
  });

  test("新种子有年龄加成", () => {
    const young = item({ ageDays: 0 });
    const old = item({ ageDays: 100 });
    const scores = scoreBatch([young, old], s);
    expect(scores.get(young)!).toBeGreaterThan(scores.get(old)!);
  });

  test("空批次返回空 Map，单元素批次不崩", () => {
    expect(scoreBatch([], s).size).toBe(0);
    const only = item({});
    expect(scoreBatch([only], s).get(only)).toBeGreaterThanOrEqual(0);
  });
});
