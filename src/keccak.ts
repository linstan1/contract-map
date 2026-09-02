/**
 * keccak256, the pre-standard Keccak padding that Ethereum uses.
 *
 * Bun ships `sha3-256`, which applies a different padding byte and therefore
 * gives different digests, so function selectors and event topics need this
 * implementation. `src/keccak.test.ts` pins it against published vectors.
 *
 * The state is 25 lanes of 64 bits in a `BigUint64Array`, lane `x + 5 * y`.
 * The application hashes a few thousand short strings per analysis, so a
 * direct implementation is fast enough and easy to check against the spec.
 */

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets of the rho step, `ROTATIONS[x][y]`. */
const ROTATIONS: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function permute(lanes: BigUint64Array): void {
  const c = new BigUint64Array(5);
  const b = new BigUint64Array(25);

  for (const rc of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) {
      c[x] = lanes[x]! ^ lanes[x + 5]! ^ lanes[x + 10]! ^ lanes[x + 15]! ^ lanes[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const next = c[(x + 1) % 5]!;
      const d = c[(x + 4) % 5]! ^ (((next << 1n) | (next >> 63n)) & MASK);
      for (let y = 0; y < 5; y++) lanes[x + 5 * y] = lanes[x + 5 * y]! ^ d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const shift = BigInt(ROTATIONS[x]![y]!);
        const lane = lanes[x + 5 * y]!;
        const rotated = shift === 0n ? lane : ((lane << shift) | (lane >> (64n - shift))) & MASK;
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotated;
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        lanes[x + 5 * y] = b[x + 5 * y]! ^ (~b[(x + 1) % 5 + 5 * y]! & b[(x + 2) % 5 + 5 * y]!);
      }
    }
    lanes[0] = lanes[0]! ^ rc;
  }
}

/** Rate of keccak256 in bytes: 1600 bits of state minus 512 bits of capacity. */
const RATE_BYTES = 136;

export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const lanes = new BigUint64Array(25);

  const absorb = (block: Uint8Array): void => {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte--) word = (word << 8n) | BigInt(block[lane * 8 + byte]!);
      lanes[lane] = lanes[lane]! ^ word;
    }
    permute(lanes);
  };

  const fullBlocks = Math.floor(input.length / RATE_BYTES);
  for (let blk = 0; blk < fullBlocks; blk++) {
    absorb(input.subarray(blk * RATE_BYTES, (blk + 1) * RATE_BYTES));
  }

  const tail = new Uint8Array(RATE_BYTES);
  const rest = input.subarray(fullBlocks * RATE_BYTES);
  tail.set(rest);
  tail[rest.length] = 0x01; // Keccak padding, where SHA-3 uses 0x06
  tail[RATE_BYTES - 1] = tail[RATE_BYTES - 1]! | 0x80;
  absorb(tail);

  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number((lanes[i >> 3]! >> BigInt((i % 8) * 8)) & 0xffn);
  }
  return out;
}

const encoder = new TextEncoder();

/** keccak256 of a UTF-8 string, as a `0x` prefixed hex digest. */
export function keccak256(text: string): string {
  const bytes = keccak256Bytes(encoder.encode(text));
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
