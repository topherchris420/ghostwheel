/**
 * MT19937 seeded exactly like CPython's random.Random(int), so a seed produces the
 * same disturbance sequence in the browser edition as in the Python backend.
 */
const N = 624;
const M = 397;

export class PythonRandom {
  private mt = new Uint32Array(N);
  private index = N;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new Error('seed_must_be_safe_integer');
    const value = Math.abs(seed);
    // CPython splits abs(seed) into little-endian 32-bit words; zero is one word.
    const high = Math.floor(value / 0x100000000);
    const key = high ? [value >>> 0, high >>> 0] : [value >>> 0];
    this.initByArray(key);
  }

  private initGenrand(seed: number) {
    const mt = this.mt;
    mt[0] = seed >>> 0;
    for (let i = 1; i < N; i++) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, previous) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: number[]) {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1,
      j = 0;
    for (let k = Math.max(N, key.length); k; k--) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private nextUint32() {
    const mt = this.mt;
    if (this.index >= N) {
      for (let k = 0; k < N; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % N] & 0x7fffffff);
        mt[k] = mt[(k + M) % N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random(): 53-bit float in [0, 1). */
  random() {
    const a = this.nextUint32() >>> 5,
      b = this.nextUint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** random.uniform(a, b). */
  uniform(a: number, b: number) {
    return a + (b - a) * this.random();
  }
}
