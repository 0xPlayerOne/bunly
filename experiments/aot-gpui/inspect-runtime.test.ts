import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectBunRuntime } from './inspect-runtime'

const directory = mkdtempSync(join(tmpdir(), 'bun-native-runtime-inspect-test-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const stateOffset = 512
const rangeOffset = 1048
const featureHeader = 64 + 2 * 64
const rangeHeader = 64 + 3 * 64

// These synthetic ELF sections test bounds and record interpretation, not AOT.
// The integration runner separately inspects actual AOT and --no-aot outputs.
function fixture(jitRemoved = true): Buffer {
  const bytes = Buffer.alloc(2048)
  bytes.writeUInt32LE(0x464c457f)
  bytes.set([2, 1, 1], 4)
  bytes.writeUInt16LE(2, 16)
  bytes.writeUInt32LE(1, 20)
  bytes.writeBigUInt64LE(64n, 40)
  bytes.writeUInt16LE(64, 52)
  bytes.writeUInt16LE(64, 58)
  bytes.writeUInt16LE(5, 60)
  bytes.writeUInt16LE(1, 62)
  const names = Buffer.from('\0.shstrtab\0.bun_features\0.bun_trim\0')
  names.copy(bytes, 384)
  function section(
    index: number,
    name: string,
    type: number,
    address: number,
    offset: number,
    size: number
  ) {
    const header = 64 + index * 64
    bytes.writeUInt32LE(names.indexOf(Buffer.from(name)), header)
    bytes.writeUInt32LE(type, header + 4)
    bytes.writeBigUInt64LE(type === 1 ? 2n : 0n, header + 8)
    bytes.writeBigUInt64LE(BigInt(address), header + 16)
    bytes.writeBigUInt64LE(BigInt(offset), header + 24)
    bytes.writeBigUInt64LE(BigInt(size), header + 32)
  }
  section(1, '.shstrtab', 3, 0, 384, names.length)
  section(2, '.bun_features', 1, 0x2000, stateOffset, 536)
  section(3, '.bun_trim', 1, 0x3000, rangeOffset, 16)
  bytes.write('BUNFEAT\0', stateOffset)
  if (jitRemoved) {
    bytes.writeUInt32LE(1, stateOffset + 12)
    bytes.writeBigInt64LE(0x1000n, stateOffset + 16)
    bytes[stateOffset + 24] = 1
    bytes[stateOffset + 27] = 1
    bytes.writeBigInt64LE(0x2000n, rangeOffset)
    bytes.writeUInt32LE(16, rangeOffset + 8)
  }
  return bytes
}

function inspect(bytes: Buffer) {
  const file = join(directory, 'fixture')
  writeFileSync(file, bytes)
  return inspectBunRuntime(file)
}

test('distinguishes JIT removal from interpreter presence and an untrimmed JIT control', () => {
  const aot = inspect(fixture())
  expect(aot.jit).toBe('unused')
  expect(aot.imageCompiler).toBe('unused')
  expect(aot.interpreter).toBe('present')
  expect(aot.jitRemovedRanges).toEqual({ count: 1, virtualBytes: 16 })
  expect(aot.rawRecordHex).toBe(
    fixture()
      .subarray(stateOffset, stateOffset + 536)
      .toString('hex')
  )
  const jit = inspect(fixture(false))
  expect(jit.jit).toBe('present')
  expect(jit.removedRangeCount).toBe(0)
})

test('ignores magic outside the named section and rejects missing or duplicate sections', () => {
  const bytes = fixture()
  bytes.write('BUNFEAT\0', 1600)
  expect(inspect(bytes).section.offset).toBe(stateOffset)
  bytes.writeUInt32LE(1, featureHeader)
  expect(() => inspect(bytes)).toThrow('Expected exactly one')
  const duplicate = fixture()
  duplicate.copy(duplicate, 64 + 4 * 64, featureHeader, featureHeader + 64)
  expect(() => inspect(duplicate)).toThrow('Expected exactly one')
})

test('rejects unsupported formats, truncated headers and malformed section tables', () => {
  expect(() => inspect(Buffer.alloc(63))).toThrow('ELF64')
  const bigEndian = fixture()
  bigEndian[5] = 2
  expect(() => inspect(bigEndian)).toThrow('ELF64')
  const objectFile = fixture()
  objectFile.writeUInt16LE(1, 16)
  expect(() => inspect(objectFile)).toThrow('ELF64')
  const missing = fixture()
  missing.writeUInt16LE(0, 60)
  expect(() => inspect(missing)).toThrow('section table')
  const outOfBounds = fixture()
  outOfBounds.writeBigUInt64LE(0xffffffffffffffffn, 40)
  expect(() => inspect(outOfBounds)).toThrow('outside the file')
  const name = fixture()
  name.writeUInt32LE(999, featureHeader)
  expect(() => inspect(name)).toThrow('outside the string table')
})

test.each([
  ['wrong section size', featureHeader + 32, 535n],
  ['unaligned section offset', featureHeader + 24, 513n],
  ['writable section', featureHeader + 8, 3n],
] as const)('rejects %s', (_name, offset, value) => {
  const bytes = fixture()
  bytes.writeBigUInt64LE(value, offset)
  expect(() => inspect(bytes)).toThrow('Invalid .bun_features section layout')
})

test.each([
  ['invalid trim state', 8, 2],
  ['excessive range count', 12, 32769],
  ['unknown removal value', 24 + 511, 3],
] as const)('rejects %s', (_name, offset, value) => {
  const bytes = fixture()
  if (offset < 24) bytes.writeUInt32LE(value, stateOffset + offset)
  else bytes[stateOffset + offset] = value
  expect(() => inspect(bytes)).toThrow('Invalid Bun runtime feature state')
})

test('rejects invalid magic, out-of-bounds feature records and range pointers', () => {
  const magic = fixture()
  magic[stateOffset] = 0
  expect(() => inspect(magic)).toThrow('feature magic')
  const size = fixture()
  size.writeBigUInt64LE(2048n, featureHeader + 24)
  expect(() => inspect(size)).toThrow('outside the file')
  const alignment = fixture()
  alignment.writeBigInt64LE(1n, stateOffset + 16)
  expect(() => inspect(alignment)).toThrow('feature state')
  const empty = fixture(false)
  empty.writeBigInt64LE(8n, stateOffset + 16)
  expect(() => inspect(empty)).toThrow('feature state')
  const ranges = fixture()
  ranges.writeUInt32LE(2, stateOffset + 12)
  expect(() => inspect(ranges)).toThrow('removed-range table')
  const duplicate = fixture()
  duplicate.copy(duplicate, 64 + 4 * 64, rangeHeader, rangeHeader + 64)
  expect(() => inspect(duplicate)).toThrow('ambiguous Bun removed-range table')
})

test.each([
  ['empty range', 8, 0],
  ['unknown feature index', 12, 512],
  ['nonzero reserved bytes', 14, 1],
] as const)('rejects %s', (_name, offset, value) => {
  const bytes = fixture()
  if (offset === 8) bytes.writeUInt32LE(value, rangeOffset + offset)
  else bytes.writeUInt16LE(value, rangeOffset + offset)
  expect(() => inspect(bytes)).toThrow('Invalid Bun removed-range record')
})

test('rejects negative or overflowing removed-range addresses', () => {
  const negative = fixture()
  negative.writeBigInt64LE(-0x2001n, rangeOffset)
  expect(() => inspect(negative)).toThrow('Invalid Bun removed-range record')
  const overflowing = fixture()
  overflowing.writeBigUInt64LE(0xffffffffffffe000n, featureHeader + 16)
  overflowing.writeBigUInt64LE(0xfffffffffffff000n, rangeHeader + 16)
  overflowing.writeBigInt64LE(0x2000n, rangeOffset)
  expect(() => inspect(overflowing)).toThrow('Invalid Bun removed-range record')
})
