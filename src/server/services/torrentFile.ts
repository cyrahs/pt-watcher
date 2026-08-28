// 最小 bencode 解析：只为定位 info dict 的原始字节区间并计算 v1 infohash (sha1)。

class Parser {
  pos = 0;

  constructor(private buf: Uint8Array) {}

  byte(): number {
    const b = this.buf[this.pos];
    if (b === undefined) throw new Error("bencode: unexpected end of data");
    return b;
  }

  private readIntUntil(terminator: number): number {
    let s = "";
    while (this.byte() !== terminator) {
      s += String.fromCharCode(this.buf[this.pos]!);
      this.pos++;
    }
    this.pos++; // skip terminator
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`bencode: bad integer ${s}`);
    return n;
  }

  parseString(): Uint8Array {
    const len = this.readIntUntil(0x3a); // ':'
    if (len < 0 || this.pos + len > this.buf.length) throw new Error("bencode: bad string length");
    const s = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  skipValue(): void {
    const b = this.byte();
    if (b === 0x69) {
      // 'i...e'
      this.pos++;
      this.readIntUntil(0x65);
    } else if (b === 0x6c) {
      // 'l...e'
      this.pos++;
      while (this.byte() !== 0x65) this.skipValue();
      this.pos++;
    } else if (b === 0x64) {
      // 'd...e'
      this.pos++;
      while (this.byte() !== 0x65) {
        this.parseString();
        this.skipValue();
      }
      this.pos++;
    } else if (b >= 0x30 && b <= 0x39) {
      this.parseString();
    } else {
      throw new Error(`bencode: unexpected byte 0x${b.toString(16)} at ${this.pos}`);
    }
  }
}

/** 从 .torrent 字节计算 v1 infohash（40 位小写 hex） */
export async function infoHashFromTorrent(data: Uint8Array): Promise<string> {
  if (data[0] !== 0x64) throw new Error("not a torrent file (no top-level dict)");
  const p = new Parser(data);
  p.pos = 1;
  let infoSpan: { start: number; end: number } | null = null;
  while (p.byte() !== 0x65) {
    const key = new TextDecoder().decode(p.parseString());
    const start = p.pos;
    p.skipValue();
    if (key === "info") infoSpan = { start, end: p.pos };
  }
  if (!infoSpan) throw new Error("torrent file has no info dict");
  const infoBytes = data.subarray(infoSpan.start, infoSpan.end);
  const digest = await crypto.subtle.digest("SHA-1", infoBytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
