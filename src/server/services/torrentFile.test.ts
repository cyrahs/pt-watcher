import { describe, expect, test } from "bun:test";
import { infoHashFromTorrent } from "./torrentFile";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function sha1hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", data as unknown as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("infoHashFromTorrent", () => {
  test("computes sha1 of the raw info dict bytes", async () => {
    const info = "d4:name5:hello6:lengthi42e12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae";
    const torrent = `d8:announce20:http://tracker/annou4:info${info}e`;
    const expected = await sha1hex(enc(info));
    expect(await infoHashFromTorrent(enc(torrent))).toBe(expected);
  });

  test("ignores keys after info and nested 'info' keys inside other dicts", async () => {
    const info = "d6:lengthi1e4:name1:xe";
    const torrent = `d3:food4:info3:bare4:info${info}7:comment2:hie`;
    const expected = await sha1hex(enc(info));
    expect(await infoHashFromTorrent(enc(torrent))).toBe(expected);
  });

  test("rejects non-torrent data", async () => {
    await expect(infoHashFromTorrent(enc("not a torrent"))).rejects.toThrow();
    await expect(infoHashFromTorrent(enc("d4:name2:hie"))).rejects.toThrow("no info dict");
  });
});
