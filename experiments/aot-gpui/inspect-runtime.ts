import { readFileSync } from 'node:fs'

// Pinned Bun da867c60: src/trim/removable_features/state.rs and
// scripts/build/trim/features.ts. engine.def assigns JIT=0, Interpreter=1,
// ImageCompiler=3. This decoder deliberately supports qualified ELF64 only.
const stateSize = 536
const removalOffset = 24
const featureCount = 512
const states = ['present', 'unused', 'requested'] as const

function bounded(bytes: Buffer, offset: bigint, length: bigint): number {
  if (offset < 0n || length < 0n || offset + length > BigInt(bytes.length))
    throw new Error('ELF range extends outside the file')
  return Number(offset)
}

function sections(bytes: Buffer) {
  if (
    bytes.length < 64 ||
    bytes.readUInt32LE(0) !== 0x464c457f ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16)) ||
    bytes.readUInt32LE(20) !== 1 ||
    bytes.readUInt16LE(52) !== 64 ||
    bytes.readUInt16LE(58) !== 64
  )
    throw new Error('Runtime feature inspection requires a little-endian ELF64 executable')
  const count = bytes.readUInt16LE(60)
  const namesIndex = bytes.readUInt16LE(62)
  if (count === 0 || namesIndex === 0 || namesIndex >= count)
    throw new Error('Missing or unsupported ELF section table')
  const table = bounded(bytes, bytes.readBigUInt64LE(40), BigInt(count * 64))
  const raw = Array.from({ length: count }, (_, index) => {
    const offset = table + index * 64
    return {
      nameOffset: bytes.readUInt32LE(offset),
      type: bytes.readUInt32LE(offset + 4),
      flags: bytes.readBigUInt64LE(offset + 8),
      address: bytes.readBigUInt64LE(offset + 16),
      offset: bytes.readBigUInt64LE(offset + 24),
      size: bytes.readBigUInt64LE(offset + 32),
    }
  })
  const names = raw[namesIndex]
  if (!names || names.type !== 3) throw new Error('Invalid ELF section-name table')
  const namesStart = bounded(bytes, names.offset, names.size)
  const nameBytes = bytes.subarray(namesStart, namesStart + Number(names.size))
  return raw.map((section) => {
    if (BigInt(section.nameOffset) >= names.size)
      throw new Error('ELF section name is outside the string table')
    const end = nameBytes.indexOf(0, section.nameOffset)
    if (end < section.nameOffset) throw new Error('Unterminated ELF section name')
    return { ...section, name: nameBytes.toString('utf8', section.nameOffset, end) }
  })
}

export function inspectBunRuntime(path: string) {
  const bytes = readFileSync(path)
  const table = sections(bytes)
  const candidates = table.filter((section) => section.name === '.bun_features')
  const section = candidates[0]
  if (candidates.length !== 1 || !section)
    throw new Error('Expected exactly one .bun_features section')
  if (
    section.type !== 1 ||
    (section.flags & 3n) !== 2n ||
    section.size !== BigInt(stateSize) ||
    section.address % 8n !== 0n ||
    section.offset % 8n !== 0n
  )
    throw new Error('Invalid .bun_features section layout')
  const offset = bounded(bytes, section.offset, section.size)
  const state = bytes.subarray(offset, offset + stateSize)
  if (!state.subarray(0, 8).equals(Buffer.from('BUNFEAT\0')))
    throw new Error('Invalid Bun runtime feature magic')
  const trimmed = state.readUInt32LE(8)
  const rangeCount = state.readUInt32LE(12)
  const rangeOffset = state.readBigInt64LE(16)
  if (
    trimmed > 1 ||
    rangeCount > 32768 ||
    rangeOffset % 8n !== 0n ||
    (rangeCount === 0 && rangeOffset !== 0n) ||
    state.subarray(removalOffset).some((value) => value > 2)
  )
    throw new Error('Invalid Bun runtime feature state')

  let jitRangeCount = 0
  let jitRangeBytes = 0
  if (rangeCount > 0) {
    const start = section.address + rangeOffset
    const length = BigInt(rangeCount * 16)
    const ranges = table.filter(
      (entry) =>
        entry.type === 1 &&
        (entry.flags & 3n) === 2n &&
        entry.address <= start &&
        start + length <= entry.address + entry.size
    )
    const rangeSection = ranges[0]
    if (ranges.length !== 1 || !rangeSection)
      throw new Error('Missing or ambiguous Bun removed-range table')
    bounded(bytes, rangeSection.offset, rangeSection.size)
    const rangeStart = bounded(bytes, rangeSection.offset + start - rangeSection.address, length)
    let previousEnd = 0n
    for (let index = 0; index < rangeCount; index++) {
      const record = rangeStart + index * 16
      const address = section.address + bytes.readBigInt64LE(record)
      const size = bytes.readUInt32LE(record + 8)
      const feature = bytes.readUInt16LE(record + 12)
      if (
        address < previousEnd ||
        address + BigInt(size) > 0xffffffffffffffffn ||
        size === 0 ||
        feature >= featureCount ||
        bytes.readUInt16LE(record + 14) !== 0
      )
        throw new Error('Invalid Bun removed-range record')
      previousEnd = address + BigInt(size)
      if (feature === 0) {
        jitRangeCount++
        jitRangeBytes += size
      }
    }
  }
  return {
    format: 'elf64-le' as const,
    section: { name: section.name, offset, bytes: stateSize },
    rawRecordHex: state.toString('hex'),
    trimmedProgramFeatures: trimmed === 1,
    removedRangeCount: rangeCount,
    jit: states[state[removalOffset]!]!,
    interpreter: states[state[removalOffset + 1]!]!,
    imageCompiler: states[state[removalOffset + 3]!]!,
    jitRemovedRanges: { count: jitRangeCount, virtualBytes: jitRangeBytes },
  }
}
