// Kleine PHP-Nachbauten, die nur dieses Paket braucht

// Wert als Array-Schlüssel wie in isset($arr[$v]): null → '', true → '1', Zahlen ganzzahlig. Ein Array als Schlüssel
// ist in PHP 8 ein TypeError (die Anfrage endet mit HTTP 500) – hier genauso.
export function phpKey(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') throw new TypeError('Cannot access offset of type array in isset or empty');
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(Math.trunc(v));
  return String(v);
}
