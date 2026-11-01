// round() wie PHP 8.3 (ext/standard/math.c, _php_math_round mit PHP_ROUND_HALF_UP): vor dem Runden wird auf die
// 15 sicheren Stellen „vorgerundet“ – daher 23/80*100 → 28.8 (Math.round(x*10)/10 ergäbe 28.7).

function intlog10abs(value: number): number {
  value = Math.abs(value);
  if (value < 1e-8 || value > 1e22) return Math.floor(Math.log10(value));
  // Binäre Suche wie in PHP (fünf Schritte über 1e-8 … 1e22)
  const values = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13,
    1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];
  let result = 15;
  result += value < values[result] ? -8 : 8;
  result += value < values[result] ? -4 : 4;
  result += value < values[result] ? -2 : 2;
  result += value < values[result] ? -1 : 1;
  if (value < values[result]) result -= 1;
  return result - 8;
}

const POWERS = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];
const intpow10 = (power: number): number => (power < 0 || power > 22 ? Math.pow(10, power) : POWERS[power]);

// php_round_helper() für PHP_ROUND_HALF_UP: halbe Werte von der Null weg
function roundHelper(value: number): number {
  return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
}

// round($value, $places)
export function phpRound(value: number, places = 0): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const precisionPlaces = 14 - intlog10abs(value);
  const f1 = intpow10(Math.abs(places));
  let tmp: number;
  if (precisionPlaces > places && precisionPlaces - 15 < places) {
    let f2 = intpow10(Math.abs(precisionPlaces));
    tmp = precisionPlaces >= 0 ? value * f2 : value / f2;
    // auf die sicheren Stellen vorrunden, dann das Komma an die gewünschte Stelle schieben
    tmp = roundHelper(tmp);
    f2 = intpow10(Math.abs(places - precisionPlaces));
    tmp = tmp / f2;
  } else {
    tmp = places >= 0 ? value * f1 : value / f1;
    // jenseits der Genauigkeit: Runden ist sinnlos
    if (Math.abs(tmp) >= 1e15) return value;
  }
  tmp = roundHelper(tmp);
  if (Math.abs(places) < 23) {
    tmp = places > 0 ? tmp / f1 : tmp * f1;
  } else {
    // PHP geht hier über einen Text ("%15fe%d") – für die Stellen, die die Seite nutzt (0 und 1), kommt das nie vor
    const back = Number(tmp.toFixed(6) + 'e' + -places);
    tmp = Number.isFinite(back) ? back : value;
  }
  return tmp;
}
