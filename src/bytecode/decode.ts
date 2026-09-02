/**
 * Decodes EVM runtime bytecode into a flat instruction list.
 *
 * The decoder is byte-exact: it walks the code once, skips the operand bytes
 * of every `PUSH` opcode, and never treats an operand byte as an opcode. It
 * also strips the solc metadata trailer before decoding, so trailer bytes
 * are never misread as code.
 */

/** One decoded instruction. `operand` is set only for `PUSH1`-`PUSH32`. */
export interface Instruction {
  /** Program counter of the opcode byte, in the trailer-stripped code. */
  pc: number;
  op: number;
  mnemonic: string;
  /** Lowercase hex, no `0x` prefix, always padded to the full push width. */
  operand?: string;
  /** Bytes this instruction occupies, opcode plus operand. */
  size: number;
}

/** Facts about a detected solc metadata trailer. */
export interface MetadataTrailer {
  /** Byte offset of the trailer, in the original (untrimmed) code. */
  offset: number;
  /** Length of the trailer in bytes, CBOR payload plus its 2-byte length field. */
  length: number;
  /** Plain-English statement of how the trailer was recognised. */
  detectedBy: string;
}

export interface DecodeResult {
  instructions: Instruction[];
  jumpdests: Set<number>;
  trailer?: MetadataTrailer;
}

const OPCODE_NAMES: Record<number, string> = {
  0x00: "STOP", 0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x05: "SDIV",
  0x06: "MOD", 0x07: "SMOD", 0x08: "ADDMOD", 0x09: "MULMOD", 0x0a: "EXP", 0x0b: "SIGNEXTEND",
  0x10: "LT", 0x11: "GT", 0x12: "SLT", 0x13: "SGT", 0x14: "EQ", 0x15: "ISZERO",
  0x16: "AND", 0x17: "OR", 0x18: "XOR", 0x19: "NOT", 0x1a: "BYTE", 0x1b: "SHL", 0x1c: "SHR", 0x1d: "SAR",
  0x20: "KECCAK256",
  0x30: "ADDRESS", 0x31: "BALANCE", 0x32: "ORIGIN", 0x33: "CALLER", 0x34: "CALLVALUE",
  0x35: "CALLDATALOAD", 0x36: "CALLDATASIZE", 0x37: "CALLDATACOPY", 0x38: "CODESIZE", 0x39: "CODECOPY",
  0x3a: "GASPRICE", 0x3b: "EXTCODESIZE", 0x3c: "EXTCODECOPY", 0x3d: "RETURNDATASIZE", 0x3e: "RETURNDATACOPY",
  0x3f: "EXTCODEHASH",
  0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO",
  0x45: "GASLIMIT", 0x46: "CHAINID", 0x47: "SELFBALANCE", 0x48: "BASEFEE",
  0x50: "POP", 0x51: "MLOAD", 0x52: "MSTORE", 0x53: "MSTORE8", 0x54: "SLOAD", 0x55: "SSTORE",
  0x56: "JUMP", 0x57: "JUMPI", 0x58: "PC", 0x59: "MSIZE", 0x5a: "GAS", 0x5b: "JUMPDEST", 0x5f: "PUSH0",
  0xf0: "CREATE", 0xf1: "CALL", 0xf2: "CALLCODE", 0xf3: "RETURN", 0xf4: "DELEGATECALL",
  0xf5: "CREATE2", 0xfa: "STATICCALL", 0xfd: "REVERT", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};
for (let n = 1; n <= 32; n++) OPCODE_NAMES[0x5f + n] = `PUSH${n}`;
for (let n = 1; n <= 16; n++) OPCODE_NAMES[0x7f + n] = `DUP${n}`;
for (let n = 1; n <= 16; n++) OPCODE_NAMES[0x8f + n] = `SWAP${n}`;
for (let n = 0; n <= 4; n++) OPCODE_NAMES[0xa0 + n] = `LOG${n}`;

function mnemonicOf(op: number): string {
  return OPCODE_NAMES[op] ?? `UNKNOWN_0x${op.toString(16).padStart(2, "0")}`;
}

function toBytes(runtimeCode: string): Uint8Array {
  const hex = runtimeCode.startsWith("0x") ? runtimeCode.slice(2) : runtimeCode;
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Finds the solc CBOR metadata trailer solc appends to runtime code.
 *
 * solc writes the trailer as a CBOR map (keys such as `ipfs`, `solc`,
 * `bzzr1`) followed by a big-endian two-byte length of that map. The
 * detector reads the last two bytes as that length, walks back that many
 * bytes, and accepts the trailer only when the byte found there is a CBOR
 * map header with one, two, or three entries (`0xa1`-`0xa3`), which is
 * exactly what every solc version emits. A contract with no such trailer
 * (Vyper, Huff, hand-assembled code) decodes its full byte range as code.
 */
export function detectMetadataTrailer(bytes: Uint8Array): MetadataTrailer | undefined {
  if (bytes.length < 4) return undefined;
  const lengthByte1 = bytes[bytes.length - 2];
  const lengthByte0 = bytes[bytes.length - 1];
  if (lengthByte1 === undefined || lengthByte0 === undefined) return undefined;
  const cborLength = (lengthByte1 << 8) | lengthByte0;
  const offset = bytes.length - 2 - cborLength;
  if (cborLength === 0 || offset <= 0 || offset >= bytes.length - 2) return undefined;
  const header = bytes[offset];
  if (header === undefined || header < 0xa1 || header > 0xa3) return undefined;
  return {
    offset,
    length: cborLength + 2,
    detectedBy:
      `the final 2 bytes encode length ${cborLength}, and the byte ${cborLength + 2} ` +
      `bytes from the end is CBOR map header 0x${header.toString(16)}`,
  };
}

/** Decodes runtime bytecode, excluding any solc metadata trailer from the instruction stream. */
export function decodeRuntime(runtimeCode: string): DecodeResult {
  const allBytes = toBytes(runtimeCode);
  const trailer = detectMetadataTrailer(allBytes);
  const codeLength = trailer ? trailer.offset : allBytes.length;

  const instructions: Instruction[] = [];
  const jumpdests = new Set<number>();
  for (let pc = 0; pc < codeLength; ) {
    const op = allBytes[pc];
    if (op === undefined) break;
    if (op >= 0x60 && op <= 0x7f) {
      const width = op - 0x5f;
      let operand = "";
      for (let i = 0; i < width; i++) {
        const byte = allBytes[pc + 1 + i];
        operand += (byte ?? 0).toString(16).padStart(2, "0");
      }
      instructions.push({ pc, op, mnemonic: mnemonicOf(op), operand, size: width + 1 });
      pc += width + 1;
      continue;
    }
    if (op === 0x5b) jumpdests.add(pc);
    instructions.push({ pc, op, mnemonic: mnemonicOf(op), size: 1 });
    pc += 1;
  }
  return { instructions, jumpdests, trailer };
}
