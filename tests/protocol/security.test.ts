import { expect, test } from 'bun:test'
import { FrameDecoder, parseCommand, PROTOCOL_VERSION } from '@bun-native/protocol'
import fixtures from '../fixtures/bridge-security.json'

test('security cases target the implemented protocol and have unique names', () => {
  expect(PROTOCOL_VERSION).toBe(fixtures.protocol)
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
})

for (const entry of fixtures.cases) {
  test(`security boundary: ${entry.name}`, () => {
    const decode = () => {
      const values = new FrameDecoder().push(new TextEncoder().encode(`${entry.wire}\n`))
      expect(values).toHaveLength(1)
      return parseCommand(values[0])
    }
    if (entry.outcome === 'accept') expect(decode()).toBeDefined()
    else if (entry.outcome === 'reject') expect(decode).toThrow()
    else throw new Error(`Unknown security fixture outcome: ${entry.outcome}`)
  })
}
