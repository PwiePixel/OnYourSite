// Wiederholbare Zufallszahlen für Testeingaben (mulberry32 – rechnet in 32 Bit, verliert also keine Stellen)
export function random(seed: number): (n: number) => number {
  let a = seed | 0;
  return (n: number): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
