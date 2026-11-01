// Geprüfte Nachbauten von PHP-Funktionen (Ergebnis der Bestandsaufnahme, gegen PHP 8.3 verglichen).
// Reines JavaScript, damit die Prüfungen 1:1 übernommen werden können; TypeScript liest es mit allowJs.
// ---------- PHP primitives ----------
import crypto from 'node:crypto'; import net from 'node:net';
import { PCRE_CYRILLIC_HAN, PCRE_LETTER } from './pcre14.js';
export const PCRE_WS = '\\t\\n\\v\\f\\r \\x85\\xA0\\u1680\\u180E\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
export const phpTrim = (s) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
export const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
export const mbSubstr = (s, start, len) => Array.from(s).slice(start, start + len).join('');
export const phpTruthy = (v) => !(v === false || v === null || v === undefined || v === 0 || v === '' || v === '0' ||
  (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0));
export function phpString(v) {
  if (v === null || v === undefined || v === false) return ''; if (v === true) return '1';
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return Object.is(v, -0) ? '-0' : String(v);
    let s = v.toPrecision(14);
    if (s.includes('e')) { let [m, ex] = s.split('e'); m = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '.0') : m + '.0';
      return m + 'E' + (ex[0] === '-' ? '-' : '+') + ex.replace(/^[+-]/, ''); }
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }
  return Array.isArray(v) || typeof v === 'object' ? 'Array' : String(v);
}
export function phpIntval(v) { // ✔
  if (v === null || v === undefined || v === false) return 0; if (v === true) return 1;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (Array.isArray(v)) return v.length ? 1 : 0; if (typeof v === 'object') return Object.keys(v).length ? 1 : 0;
  const m = /^[ \t\n\r\v\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(String(v));
  return m && Number.isFinite(Number(m[1])) ? Math.trunc(Number(m[1])) : 0;
}
export const e = (v) => phpString(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]); // ✔
export const rawurlencode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const phpJson = (d) => JSON.stringify(d).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); // UNESCAPED_UNICODE|SLASHES
export const nl2br = (s) => s.replace(/(\r\n|\n\r|\n|\r)/g, '<br />$1'); // ✔

// ---------- security.php ✔ (both directions) ----------
const phpKey = (k) => { const b = Buffer.alloc(32); Buffer.from(k, 'utf8').copy(b, 0, 0, 32); return b; };
const phpEmpty = (v) => v === undefined || v === null || v === '' || v === '0' || v === false || v === 0;
export function encryptData(p, aesKey) {
  if (phpEmpty(p)) return p; p = String(p); if (p.startsWith('ENC:')) return p;
  const iv = crypto.randomBytes(16), c = crypto.createCipheriv('aes-256-cbc', phpKey(aesKey), iv);
  const inner = Buffer.concat([c.update(p, 'utf8'), c.final()]).toString('base64');
  return 'ENC:' + Buffer.concat([iv, Buffer.from(inner, 'latin1')]).toString('base64');
}
function strictB64(s) {
  s = s.replace(/[ \t\r\n]/g, ''); const m = /^([A-Za-z0-9+/]*)(=*)$/.exec(s); if (!m) return null;
  const n = m[1].length, pad = m[2].length; if (n % 4 === 1) return null;
  if (pad && (pad > 2 || (n + pad) % 4 !== 0)) return null; return Buffer.from(m[1], 'base64');
}
export function decryptData(s, aesKey) {
  if (phpEmpty(s)) return s; s = String(s); if (!s.startsWith('ENC:')) return s;
  const d = strictB64(s.slice(4)); if (!d || d.length <= 16) return s;
  const inner = strictB64(d.subarray(16).toString('latin1')); if (!inner) return s;
  try { const x = crypto.createDecipheriv('aes-256-cbc', phpKey(aesKey), d.subarray(0, 16));
    return Buffer.concat([x.update(inner), x.final()]).toString('utf8'); } catch { return s; }
}

// ---------- hmac / client key ✔ ----------
export function oysHmac(data, cfg) {
  let secret = phpString(cfg.app_secret ?? '');
  if (secret === '') secret = crypto.createHash('sha256').update('oys|' + phpString(cfg.aes_key ?? '') + '|' + phpString(cfg.db?.pass ?? '')).digest('hex');
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function ipv6Bytes(ip) { // = inet_pton for IPv6, else null
  if (ip.includes('%') || !net.isIPv6(ip)) return null;
  let head = ip, v4 = null; const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (m) { head = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1); v4 = m[2].split('.').map(Number); }
  const [l, r] = head.split('::'); const words = (s) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
  const left = words(l), right = words(r);
  const all = r === undefined ? left : [...left, ...Array((v4 ? 6 : 8) - left.length - right.length).fill(0), ...right];
  if (v4) all.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
  const b = Buffer.alloc(16); all.forEach((w, i) => b.writeUInt16BE(w, i * 2)); return b;
}
const MAPPED = Buffer.from('00000000000000000000ffff', 'hex');
export function oysClientKey(remoteAddr, cfg, now = new Date()) {
  let ip = remoteAddr ?? ''; const b = ipv6Bytes(ip);
  if (b && !b.subarray(0, 12).equals(MAPPED)) ip = b.subarray(0, 8).toString('hex') + '/64';
  return oysHmac('client|' + now.toISOString().slice(0, 10) + '|' + ip, cfg).slice(0, 16);
}

// ---------- helpers.php ✔ ----------
const isScalar = (v) => ['string', 'number', 'boolean'].includes(typeof v);
export function oysCleanText(value, max = 255, multiline = false) {
  let v = isScalar(value) ? phpString(value) : '';
  v = multiline ? v.replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]+|[\u202A-\u202E\u2066-\u2069]+/g, '')
                : v.replace(/[\x00-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]+/g, '');
  v = phpTrim(v); if (multiline) v = v.replace(/\n{3,}/g, '\n\n'); return mbSubstr(v, 0, max);
}
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
export function oysCleanUrl(value, allowRelative = false) {
  let url = phpTrim(isScalar(value) ? phpString(value) : '').replace(new RegExp(`[${PCRE_WS}]+`, 'gu'), '');
  if (url === '') return '';
  if (allowRelative && /^\/[^/]/.test(url)) return mbSubstr(url, 0, 500);
  if (!SCHEME.test(url) && /^[^@\t\n\v\f\r \/]+@[^@\t\n\v\f\r \/]+\.[a-z]{2,}\n?$/i.test(url)) url = 'mailto:' + url;
  if (!SCHEME.test(url) && /^(\+|00)[0-9 ()\/-]{6,}\n?$/.test(url)) url = 'tel:' + url.replace(/[^0-9+]/g, '');
  if (!SCHEME.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  const pu = phpParseUrl(url); const scheme = asciiLower(pu === false ? '' : (pu.scheme ?? ''));
  if (!['http', 'https', 'mailto', 'tel'].includes(scheme)) return '';
  if ((scheme === 'http' || scheme === 'https') && !phpFilterValidateUrl(url)) {
    const host = pu === false ? undefined : pu.host; if (!host || host === '0' || !host.includes('.')) return '';
  }
  return mbSubstr(url, 0, 1000);
}
export const oysPrettyUrl = (u) => /^mailto:/i.test(u) ? u.slice(7) : /^tel:/i.test(u) ? u.slice(4) : u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
export const oysNormalizeSlug = (s) => asciiLower(phpTrim(phpString(s))).replace(/[^a-z0-9-]/g, '');
export function oysInitials(name) {
  const t = phpTrim(name);
  const parts = (t === '' ? [''] : t.split(new RegExp(`[${PCRE_WS}]+`, 'u'))).filter((p) => /^[\p{L}\p{N}]/u.test(p));
  const ini = parts.slice(0, 2).map((p) => Array.from(p)[0].toUpperCase()).join(''); return ini !== '' ? ini : '?';
}
export const oysIsBot = (ua) => ua === '' || /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|monitor|curl|wget|python|java\/|go-http|okhttp|discordapp|whatsapp|telegram|skype|vkshare|quora link|bitlybot|feedfetcher|ahrefs|semrush|mj12|yandex|baidu|bingpreview/i.test(ua);

// ---------- PHP parse_url (php_url_parse_ex2), byte-exact ✔ ----------
const isAlpha = (c) => /[A-Za-z]/.test(c), isDigit = (c) => c >= '0' && c <= '9';
const ctrl = (s) => s.replace(/[\x00-\x1F\x7F]/g, '_');
function strcspn(str, s, ue, chars) { let e = ue; for (const ch of chars) { const p = str.indexOf(ch, s); if (p !== -1 && p < e) e = p; } return e; }
function strtolPort(buf) { const m = /^[\t\n\v\f\r ]*([+-]?)(\d+)/.exec(buf); return m ? (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10) : null; }
export function phpParseUrl(input) { // returns false or {scheme,host,port,user,pass,path,query,fragment}
  const str = Buffer.from(input, 'utf8').toString('latin1'); const ret = {}; let hasPort = false, s = 0, e, p, pp; const ue = str.length;
  const finish = () => { const o = {}; for (const k of ['scheme', 'host', 'port', 'user', 'pass', 'path', 'query', 'fragment'])
    if (k in ret) o[k] = typeof ret[k] === 'string' ? Buffer.from(ret[k], 'latin1').toString('utf8') : ret[k]; if (!hasPort) delete o.port; return o; };
  const just_path = () => { let e2 = ue, q = str.indexOf('#', s);
    if (q !== -1 && q < e2) { const f = q + 1; ret.fragment = f < e2 ? ctrl(str.slice(f, e2)) : ''; e2 = q; }
    q = str.indexOf('?', s); if (q !== -1 && q < e2) { const f = q + 1; ret.query = f < e2 ? ctrl(str.slice(f, e2)) : ''; e2 = q; }
    if (s < e2 || s === ue) ret.path = ctrl(str.slice(s, e2)); return finish(); };
  const parse_port = () => { p = e + 1; pp = p; while (pp < ue && pp - p < 6 && isDigit(str[pp])) pp++;
    if (pp - p > 0 && pp - p < 6 && (pp === ue || str[pp] === '/')) { const port = strtolPort(str.slice(p, pp));
      if (port !== null && port >= 0 && port <= 65535) { hasPort = true; ret.port = port; if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') s += 2; return 'host'; } return false; }
    else if (p === pp && pp === ue) return false; else if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') { s += 2; return 'host'; } return 'path'; };
  const parse_host = () => { e = strcspn(str, s, ue, '/?#');
    p = str.lastIndexOf('@', e - 1); if (p < s) p = -1;
    if (p !== -1) { pp = str.indexOf(':', s); if (pp !== -1 && pp < p) { ret.user = ctrl(str.slice(s, pp)); ret.pass = ctrl(str.slice(pp + 1, p)); } else ret.user = ctrl(str.slice(s, p)); s = p + 1; }
    if (s < ue && str[s] === '[' && str[e - 1] === ']') p = -1; else { p = e - 1 >= s ? str.lastIndexOf(':', e - 1) : -1; if (p < s) p = -1; }
    if (p !== -1) { if (!ret.port) { p++; if (e - p > 5) return false;
        else if (e - p > 0) { const port = strtolPort(str.slice(p, e)); if (port !== null && port >= 0 && port <= 65535) { hasPort = true; ret.port = port; } else return false; } p--; } }
    else p = e;
    if (p - s < 1) return false; ret.host = ctrl(str.slice(s, p)); if (e === ue) return finish(); s = e; return just_path(); };
  const go = (r) => r === false ? false : r === 'host' ? parse_host() : just_path();
  e = str.indexOf(':');
  if (e !== -1 && e !== 0) {
    for (p = s; p < e; p++) { const c = str[p];
      if (!isAlpha(c) && !isDigit(c) && c !== '+' && c !== '.' && c !== '-') {
        if (e + 1 < ue && e < strcspn(str, s, ue, '?#')) return go(parse_port());
        if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') { s += 2; return parse_host(); } return just_path(); } }
    if (e + 1 === ue) { ret.scheme = ctrl(str.slice(s, e)); return finish(); }
    if (str[e + 1] !== '/') { p = e + 1; while (p < ue && isDigit(str[p])) p++;
      if ((p === ue || str[p] === '/') && p - e < 7) return go(parse_port());
      ret.scheme = ctrl(str.slice(s, e)); s = e + 1; return just_path(); }
    ret.scheme = ctrl(str.slice(s, e));
    if (e + 2 < ue && str[e + 2] === '/') { s = e + 3;
      if (ret.scheme.toLowerCase() === 'file' && e + 3 < ue && str[e + 3] === '/') { if (e + 5 < ue && str[e + 5] === ':') s = e + 4; return just_path(); }
      return parse_host(); }
    s = e + 1; return just_path();
  } else if (e !== -1) return go(parse_port());
  else if (s + 1 < ue && str[s] === '/' && str[s + 1] === '/') { s += 2; return parse_host(); }
  return just_path();
}
// ---------- FILTER_VALIDATE_URL (no flags) ✔ ----------
const URL_ALLOWED = /^[A-Za-z0-9$\-_.+!*'(),{}|\\^~\[\]`<>#%";\/?:@&=]*$/;
function validHostname(d) { let l = d.length, end = l; if (l > 0 && d[l - 1] === '.') { end = l - 1; l--; } if (l > 253) return false;
  const an = (c) => c !== undefined && /[A-Za-z0-9]/.test(c); if (d[0] === '.' || !an(d[0])) return false; let i = 1;
  for (let s = 0; s < end; s++) { if (d[s] === '.') { if (d[s + 1] === '.' || !an(d[s - 1]) || !an(d[s + 1])) return false; i = 1; }
    else { if (i > 63 || (d[s] !== '-' && !an(d[s]))) return false; i++; } } return true; } // trailing '-' allowed ✔
function validIpv4(s) { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); return !!m && m.slice(1).every((x) => (x.length === 1 || x[0] !== '0') && +x <= 255); }
function validIpv6(str) { if (!str.includes(':')) return false; let len = str.length, blocks = 0, comp = -1; const dot = str.indexOf('.');
  if (dot !== -1) { let v4 = dot; while (v4 > 0 && str[v4 - 1] !== ':') v4--; if (!validIpv4(str.slice(v4))) return false; len = v4; if (len < 2) return false; if (str[v4 - 2] !== ':') len--; blocks = 2; }
  let i = 0; while (i < len) { if (str[i] === ':') { if (++i >= len) return false;
      if (str[i] === ':') { if (comp >= 0) return false; comp = blocks++; if (++i === len) return blocks <= 8; } else if (i - 1 === 0) return false; }
    let n = 0; while (i < len && /[0-9a-fA-F]/.test(str[i])) { n++; i++; } if (n < 1 || n > 4) return false; if (++blocks > 8) return false; }
  return (comp >= 0 && blocks <= 8) || blocks === 8; }
const validUserinfo = (u) => /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:]|%[0-9][0-9A-Fa-f])*$/.test(u);
export function phpFilterValidateUrl(v) {
  if (!URL_ALLOWED.test(v)) return false; const u = phpParseUrl(v); if (u === false) return false;
  if (u.scheme !== undefined && /^https?$/i.test(u.scheme)) { if (u.host === undefined) return false; const h = u.host;
    if (!(h[0] === '[' && h[h.length - 1] === ']' && validIpv6(h.slice(1, -1))) && !validHostname(h)) return false; }
  if (u.scheme === undefined || (u.host === undefined && !['mailto', 'news', 'file'].includes(u.scheme))) return false;
  if ((u.user !== undefined && !validUserinfo(u.user)) || (u.pass !== undefined && !validUserinfo(u.pass))) return false;
  return true;
}
// ---------- FILTER_VALIDATE_EMAIL, ReDoS-safe ✔ (26k cases; crafted 300-char inputs < 0.1 ms) ----------
const ATOM = "[\\x21\\x23-\\x27\\x2A\\x2B\\x2D\\x2F-\\x39\\x3D\\x3F\\x5E-\\x7E]+";
const QUOTED = "\\x22(?:[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x21\\x23-\\x5B\\x5D-\\x7F]|\\x5C[\\x00-\\x7F])*\\x22";
const LOCAL = new RegExp(`^(?:${ATOM}|${QUOTED})(?:\\.(?:${ATOM}|${QUOTED}))*$`, 'i');
const HOST = /^(?:[a-z0-9]+(?:-+[a-z0-9]+)*\.)+(?:[a-z][a-z0-9]*|xn--[a-z0-9]+)(?:-+[a-z0-9]+)*$/i;
const V4 = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}', H = '[a-f0-9]{1,4}';
const L_V4 = new RegExp(`^${V4}$`), L_F6 = new RegExp(`^IPv6:${H}(?::${H}){7}$`, 'i'), L_C6 = new RegExp(`^IPv6:(?:${H}(?::${H}){0,5})?::(?:${H}(?::${H}){0,5})?$`, 'i');
const L_F6V4 = new RegExp(`^IPv6:${H}(?::${H}){5}:${V4}$`, 'i'), L_C6V4 = new RegExp(`^IPv6:(?:${H}(?::${H}){0,3})?::(?:${H}(?::${H}){0,3}:)?${V4}$`, 'i');
const cnt = (s, re) => (s.match(re) || []).length;
function lookaheadsReject(s) { // PHP's (?!U{255,}) and (?!U{65,}@), U = "?(\\[\x00-\x7E]|[^\\"])"?
  let i = 0, units = 0;
  for (;;) { const q0 = i; while (s[i] === '"') i++; if (i - q0 > (units === 0 ? 1 : 2)) return false;
    if (s[i] === '\\' && i + 1 < s.length && s.charCodeAt(i + 1) <= 0x7e) i += 2; else if (i < s.length && s[i] !== '\\' && s[i] !== '"') i += 1; else return false;
    units++; if (units >= 255) return true; if (units >= 65 && (s[i] === '@' || (s[i] === '"' && s[i + 1] === '@'))) return true; }
}
export function phpValidateEmail(s) {
  if (Buffer.byteLength(s, 'utf8') > 320) return false; const at = s.lastIndexOf('@'); if (at < 1) return false;
  const local = s.slice(0, at), domain = s.slice(at + 1); if (!LOCAL.test(local) || lookaheadsReject(s)) return false;
  if (domain.startsWith('[') && domain.endsWith(']')) { const lit = domain.slice(1, -1), rest = lit.slice(5) + ']';
    if (L_V4.test(lit) || L_F6.test(lit) || L_F6V4.test(lit)) return true;
    if (L_C6.test(lit)) return cnt(rest, /[a-f0-9][:\]]/gi) < 7; if (L_C6V4.test(lit)) return cnt(rest, /[a-f0-9]:/gi) < 5; return false; }
  return !/[^.]{64,}/.test(domain) && HOST.test(domain);
}
// ---------- blacklist.php ✔ (pass the arrays copied from blacklist.php) ----------
const squash = (s) => s.replace(/(.)\1+/gu, '$1');
export function makeBlacklist({ subdomains, contains, regex }) {
  const subSq = [...new Set(subdomains.map(squash))], conSq = [...new Set(contains.map(squash).filter((w) => Buffer.byteLength(w) >= 3))];
  const leet = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '+': 't' };
  const variants = (sub) => { const base = phpTrim(sub.toLowerCase()).replace(/[_ ./\\\t\n\r]/g, '-'); const l = base.replace(/[0-9@$!+]/g, (c) => leet[c]);
    const out = []; for (const v of [base.replace(/[^a-z0-9-]/g, ''), l.replace(/[^a-z0-9-]/g, ''), base.replace(/[^a-z0-9]/g, ''), l.replace(/[^a-z0-9]/g, ''), base.replace(/[^a-z]/g, ''), l.replace(/[^a-z]/g, '')])
      if (v !== '') out.push(v, squash(v)); return [...new Set(out)]; };
  return (sub) => { sub = phpTrim(sub); if (sub === '' || Buffer.byteLength(sub) > 63 || sub[0] === '-' || sub.endsWith('-') || !/^[a-z0-9-]+\n?$/i.test(sub)) return true;
    for (const v of variants(sub)) { const sq = squash(v);
      if (subdomains.includes(v) || subSq.includes(sq) || regex.some((r) => r.test(v) || r.test(sq)) || contains.some((n) => n !== '' && v.includes(n)) || conSq.some((n) => n !== '' && sq.includes(n))) return true; }
    return false; };
}
// ---------- spam.php ✔ ----------
const SPAM_LETTER = new RegExp('[' + PCRE_LETTER + ']', 'gu');
const SPAM_FOREIGN = new RegExp('[' + PCRE_CYRILLIC_HAN + ']', 'gu');
export function oysLooksLikeSpam(text) {
  const lower = text.toLowerCase();
  if ((text.match(/https?:\/\/|www\./gi) || []).length > 2) return true;
  if (/\[url=|<a[\t\n\v\f\r ]+href|\[link=/i.test(text)) return true;
  const words = ['viagra', 'cialis', 'casino', 'porn', 'xxx', 'crypto investment', 'bitcoin investment', 'forex', 'loan offer', 'seo services', 'backlinks', 'rank your website', 'guest post', 'buy followers', 'cheap followers', 'onlyfans leak', 'escort', 'betting tips', 'binary option', 'payday loan', 'weight loss pill', 'work from home and earn'];
  if (words.some((w) => lower.includes(w))) return true;
  // Klassen wie PCRE2 10.42 (Unicode 14): \p{Cyrillic}/\p{Han} sind dort Schrift-Erweiterungen (CJK-Satzzeichen zählen mit)
  const letters = (text.match(SPAM_LETTER) || []).length, foreign = (text.match(SPAM_FOREIGN) || []).length;
  return letters > 20 && foreign / Math.max(1, letters) > 0.6;
}
