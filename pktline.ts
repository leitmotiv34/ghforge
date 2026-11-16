// pkt-line framing, the length-prefixed packet format every git smart-HTTP
// exchange is built from: four hex digits give the total frame length
// including the digits themselves; 0000 is a flush, 0001 a delimiter and
// 0002 the response end (protocol v2).

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type PktFrame =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Split a buffer into its frames; throws on a truncated or invalid frame. */
export function readPkts(buf: Buffer): PktFrame[] {
  const frames: PktFrame[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(at, at + 4).toString('ascii');
    const length = Number.parseInt(head, 16);
    if (Number.isNaN(length) || length < 0) throw new Error(`invalid pkt-line length ${head}`);
    if (length === 0) {
      frames.push({ kind: 'flush' });
      at += 4;
    } else if (length === 1) {
      frames.push({ kind: 'delim' });
      at += 4;
    } else if (length === 2) {
      frames.push({ kind: 'end' });
      at += 4;
    } else {
      if (at + length > buf.length) throw new Error('truncated pkt-line payload');
      frames.push({ kind: 'data', data: buf.subarray(at + 4, at + length) });
      at += length;
    }
  }
  return frames;
}

/** One sideband frame: a channel byte (1 pack, 2 progress, 3 error) + data. */
export function sideband(channel: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([channel]), data]));
}
