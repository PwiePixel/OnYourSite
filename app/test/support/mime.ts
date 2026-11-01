// E-Mails für Tests lesen: Kopfzeilen (entfaltet, =?UTF-8?…?= dekodiert), Teile von multipart/*, Inhalte aus
// quoted-printable oder base64 zurück in Text. Genug, um zwei Nachrichten inhaltlich zu vergleichen.

export interface MimePart {
  headers: Array<[string, string]>; // Name klein, Wert entfaltet (noch kodiert)
  type: string; // z. B. text/html
  params: Record<string, string>;
  encoding: string;
  body: Buffer; // dekodierter Inhalt
  parts: MimePart[];
}

function splitHead(raw: Buffer): { head: string; body: Buffer } {
  const i = raw.indexOf('\r\n\r\n');
  if (i < 0) return { head: raw.toString('latin1'), body: Buffer.alloc(0) };
  return { head: raw.subarray(0, i).toString('latin1'), body: raw.subarray(i + 4) };
}

function parseHeaders(head: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1][1] += line.replace(/^[ \t]+/, ' ');
    else if (line.includes(':')) out.push([line.slice(0, line.indexOf(':')).trim().toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]);
  }
  // Kopfzeilen sind 8-Bit-sicher gelesen (latin1) – als UTF-8 zurück
  return out.map(([k, v]) => [k, Buffer.from(v, 'latin1').toString('utf8')]);
}

export function header(part: MimePart, name: string): string | undefined {
  return part.headers.find(([k]) => k === name)?.[1];
}

function parseContentType(v: string): { type: string; params: Record<string, string> } {
  const [type, ...rest] = v.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeQp(text: string): Buffer {
  const soft = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  if (encoding === 'quoted-printable') return decodeQp(body.toString('latin1'));
  if (encoding === 'base64') return Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
  return body;
}

export function parseMessage(raw: Buffer): MimePart {
  const { head, body } = splitHead(raw);
  const headers = parseHeaders(head);
  const ct = parseContentType(headers.find(([k]) => k === 'content-type')?.[1] ?? 'text/plain');
  const encoding = (headers.find(([k]) => k === 'content-transfer-encoding')?.[1] ?? '7bit').toLowerCase();
  const part: MimePart = { headers, type: ct.type, params: ct.params, encoding, body: Buffer.alloc(0), parts: [] };
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    const text = body.toString('latin1');
    const delim = '--' + ct.params.boundary;
    const chunks = text.split(new RegExp('(?:^|\\r\\n)' + delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?[ \\t]*(?:\\r\\n|$)'));
    // Erstes Stück = Präambel, letztes = Epilog
    for (const c of chunks.slice(1, -1)) part.parts.push(parseMessage(Buffer.from(c, 'latin1')));
    return part;
  }
  part.body = decodeBody(body, encoding);
  return part;
}

// Alle Blätter (die eigentlichen Inhalte) in Reihenfolge
export function leaves(part: MimePart): MimePart[] {
  return part.parts.length ? part.parts.flatMap(leaves) : [part];
}

// RFC 2047: =?charset?B|Q?…?= dekodieren; Leerraum zwischen zwei kodierten Wörtern fällt weg
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQp(text.replace(/_/g, ' '));
      return /utf-?8/i.test(charset) ? bytes.toString('utf8') : bytes.toString('latin1');
    });
}

// "Name" <a@b>, Name <a@b>, a@b → { name, address }
export function parseAddress(value: string | undefined): { name: string; address: string } | null {
  if (value === undefined) return null;
  const v = decodeWords(value).trim();
  const m = /^(.*?)\s*<([^>]*)>$/.exec(v);
  if (!m) return { name: '', address: v };
  let name = m[1].trim();
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return { name, address: m[2] };
}
