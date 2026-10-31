import { NativeCommandError, NativeHost, type WindowCommand } from '@bun-native/runtime'
import { type ErrorCode, type Operation, PROTOCOL_VERSION } from '@bun-native/protocol'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: 'string' },
    'host-profile': { type: 'string' },
    mode: { type: 'string' },
    source: { type: 'string' },
    output: { type: 'string' },
    'aot-manifest': { type: 'string' },
    instrument: { type: 'boolean', default: false },
  },
})

function absolute(value: string | undefined, option: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${option} requires an absolute path`)
  return value
}
const executable = absolute(values.host, '--host')
const source = absolute(values.source, '--source')
const output = absolute(values.output, '--output')
const mode = values.mode
if (mode !== 'development' && mode !== 'aot') throw new Error('--mode requires development or aot')
const hostProfile = values['host-profile']
if (hostProfile !== 'dev' && hostProfile !== 'release')
  throw new Error('--host-profile requires dev or release')
if (mode === 'aot') absolute(values['aot-manifest'], '--aot-manifest')
else if (values['aot-manifest']) throw new Error('--aot-manifest is only valid with --mode aot')

type RecordValue = Record<string, unknown>
function record(value: unknown, name: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${name}`)
  return value as RecordValue
}
function readJson(path: string): unknown {
  if (statSync(path).size > 1_048_576) throw new Error(`Metadata file exceeds 1 MiB: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}
async function artifact(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: statSync(path).size, sha256: hash.digest('hex') }
}
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', source, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`Source provenance command failed: git ${args.join(' ')}`)
  return result.stdout.toString().trim()
}

const toolchain = record(readJson(join(source, 'toolchain.json')), 'toolchain')
assert.equal(
  Bun.revision,
  record(toolchain['bun'], 'Bun pin')['revision'],
  'Use the pinned Bun runtime/compiler'
)
const paths = [
  'benchmarks/bridge.ts',
  'examples/native-window/main.ts',
  'examples/native-window/content.ts',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'bunfig.toml',
  'packages/protocol/package.json',
  'packages/runtime/package.json',
  'packages/core/package.json',
  '.bun-version',
  'rust-toolchain.toml',
  'toolchain.json',
  'Cargo.toml',
  'Cargo.lock',
  'native/gpui-host/Cargo.toml',
  'native/protocol/Cargo.toml',
]
for await (const path of new Bun.Glob('packages/{core,protocol,runtime}/src/**/*.ts').scan({
  cwd: source,
}))
  paths.push(path)
for await (const path of new Bun.Glob('native/{gpui-host,protocol}/src/**/*.rs').scan({
  cwd: source,
}))
  paths.push(path)
const files = await Promise.all(
  paths.sort().map(async (path) => ({ path, ...(await artifact(join(source, path))) }))
)
const [application, nativeHost] = await Promise.all([
  artifact(process.execPath),
  artifact(executable),
])

// Corroborating runtime witness, executed before timing. The exact pinned AOT
// compiler freezes built-ins. Artifact metadata remains the primary evidence.
const builtinKey = ['pu', 'sh'].join('')
const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, builtinKey)
assert(descriptor)
let readonlyBuiltin = false
try {
  Object.defineProperty(Array.prototype, builtinKey, { value: () => 0 })
} catch (error) {
  if (!(error instanceof TypeError)) throw error
  readonlyBuiltin = true
} finally {
  if (!readonlyBuiltin) Object.defineProperty(Array.prototype, builtinKey, descriptor)
}
assert.equal(
  readonlyBuiltin,
  mode === 'aot',
  'Runtime witness disagrees with requested execution mode'
)

let aotEvidence: RecordValue | undefined
if (mode === 'aot') {
  const manifestPath = absolute(values['aot-manifest'], '--aot-manifest')
  const manifest = record(readJson(manifestPath), 'AOT manifest')
  const builtApplication = record(manifest['application'], 'AOT application')
  const builtHost = record(manifest['host'], 'AOT native host')
  const inspection = record(builtApplication['inspection'], 'AOT inspection')
  assert.equal(
    builtApplication['sha256'],
    application.sha256,
    'AOT manifest belongs to a different executable'
  )
  assert.equal(builtApplication['bytes'], application.bytes)
  assert.equal(inspection['hasCompiledProgram'], true, 'Manifest lacks compiled-program evidence')
  assert.equal(
    builtHost['sha256'],
    nativeHost.sha256,
    'AOT manifest belongs to a different native host'
  )
  assert.equal(builtHost['bytes'], nativeHost.bytes)
  assert.equal(builtHost['profile'], hostProfile)
  if (platform() === 'linux') {
    const features = record(builtApplication['runtimeFeatures'], 'Linux runtime features')
    assert(
      features['jit'] === 'unused' || features['jit'] === 'requested',
      'Qualified Linux AOT must not retain the JIT feature'
    )
    assert(typeof features['removedRangeCount'] === 'number' && features['removedRangeCount'] > 0)
    const ranges = record(features['jitRemovedRanges'], 'JIT removal ranges')
    assert(typeof ranges['count'] === 'number' && ranges['count'] > 0)
  }
  const buildSource = record(manifest['source'], 'AOT build source')
  assert(Array.isArray(buildSource['files']), 'AOT manifest needs exact build source hashes')
  const builtFiles = buildSource['files'].map((value: unknown) => record(value, 'AOT source file'))
  for (const file of files) {
    const built = builtFiles.find((item) => item['path'] === file.path)
    assert(
      built && built['sha256'] === file.sha256 && built['bytes'] === file.bytes,
      `AOT build source changed: ${file.path}`
    )
  }
  aotEvidence = {
    manifest: await artifact(manifestPath),
    inspection,
    runtimeFeatures: builtApplication['runtimeFeatures'],
    verification:
      'external build inspection bound to the actual executable/host by streaming SHA-256 and source hashes',
  }
}

// Creating a new directory refuses to overwrite any previous trial.
mkdirSync(output)
const nonce = crypto.randomUUID()
if (values.instrument) {
  process.env['BUN_NATIVE_EVIDENCE_LOG'] = join(output, 'native-events.jsonl')
  process.env['BUN_NATIVE_EVIDENCE_NONCE'] = nonce
} else {
  delete process.env['BUN_NATIVE_EVIDENCE_LOG']
  delete process.env['BUN_NATIVE_EVIDENCE_NONCE']
}
const result: RecordValue = {
  schemaVersion: 1,
  status: 'running',
  protocol: PROTOCOL_VERSION,
  startedAt: new Date().toISOString(),
  execution: {
    mode,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    readonlyBuiltin,
    application,
    aotEvidence,
    argv: process.argv,
  },
  nativeHost: {
    ...nativeHost,
    profile: hostProfile,
    buildProvenance:
      'Match this prebuilt host hash to native build evidence; this runner does not invoke Cargo.',
  },
  source: {
    repository: 'https://github.com/0xPlayerOne/bun-native',
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
    files,
  },
  toolchain,
  target: { os: platform(), architecture: arch(), osRelease: release() },
  display: {
    x11: process.env['DISPLAY'] ?? null,
    wayland: process.env['WAYLAND_DISPLAY'] ?? null,
    vulkanDriverFiles: process.env['VK_DRIVER_FILES'] ?? null,
    softwareGlRequested: process.env['LIBGL_ALWAYS_SOFTWARE'] ?? null,
  },
  methodology: {
    measured: 'Bun send through native UI-thread Applied acknowledgement',
    excludedFromAckSamples: 'preflight hashing, startup, display presentation and OS input latency',
    instrumentation: values.instrument,
    warmupRequests: 20,
    textNodes: 1000,
    nativeInputEntityLifecycles: 1000,
    controlledPageCache: false,
    framePresentation: 'not measured',
    memoryLeaks: 'not established by this bounded lifecycle run',
    nativeRss: 'not measured by this runner; use the separate owned-process native harness',
  },
}
const individual: number[] = []
const batched: number[] = []
function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
  return {
    count: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    totalMs: samples.reduce((sum, sample) => sum + sample, 0),
    samplesMs: samples,
  }
}

let host: NativeHost | undefined
let failure: unknown
const started = performance.now()
try {
  const running = await NativeHost.launch({ executable })
  host = running
  const events = running[Symbol.asyncIterator]()
  let revision = 0
  const text = (value: string) => ({ kind: 'text' as const, text: value })
  const input = (value: string) => ({ kind: 'input' as const, value })
  async function rejected(command: WindowCommand, code: ErrorCode) {
    await assert.rejects(
      running.send(command),
      (error: unknown) => error instanceof NativeCommandError && error.code === code
    )
  }
  async function batch(operations: Operation[]) {
    if (performance.now() - started > 120_000)
      throw new Error('Native benchmark exceeded its 120-second workload budget')
    const reply = await running.send({
      type: 'batch',
      window_id: 1,
      base_revision: revision,
      operations,
    })
    revision = reply.tree_revision
  }
  await rejected({ type: 'close', window_id: 1 }, 'invalid_handle')
  await running.send({
    type: 'open',
    window_id: 1,
    root_id: 1,
    title: 'Bun Native bridge benchmark',
    width: 640,
    height: 480,
  })
  await batch([
    { type: 'create', node_id: 2, element: { kind: 'box' } },
    { type: 'insert', parent_id: 1, child_id: 2, index: 0 },
    { type: 'create', node_id: 3, element: input('') },
    { type: 'insert', parent_id: 2, child_id: 3, index: 0 },
    { type: 'create', node_id: 4, element: text('original') },
    { type: 'insert', parent_id: 2, child_id: 4, index: 1 },
  ])
  await running.send({
    type: 'open',
    window_id: 2,
    root_id: 5,
    title: 'Second native owner',
    width: 320,
    height: 240,
  })
  await running.send({
    type: 'batch',
    window_id: 2,
    base_revision: 0,
    operations: [
      { type: 'create', node_id: 6, element: text('other window') },
      { type: 'insert', parent_id: 5, child_id: 6, index: 0 },
    ],
  })
  await rejected(
    {
      type: 'batch',
      window_id: 1,
      base_revision: revision,
      operations: [{ type: 'set', node_id: 6, element: text('foreign') }],
    },
    'invalid_handle'
  )
  await rejected(
    {
      type: 'batch',
      window_id: 1,
      base_revision: revision,
      operations: [
        { type: 'set', node_id: 4, element: text('must roll back') },
        { type: 'insert', parent_id: 2, child_id: 1, index: 0 },
      ],
    },
    'invalid_state'
  )
  await batch([{ type: 'set', node_id: 4, element: text('revision preserved after rejection') }])
  await rejected(
    {
      type: 'batch',
      window_id: 1,
      base_revision: revision,
      operations: [{ type: 'create', node_id: 7, element: { kind: 'box' } }],
    },
    'invalid_state'
  )
  await batch([
    { type: 'create', node_id: 7, element: { kind: 'box' } },
    { type: 'insert', parent_id: 1, child_id: 7, index: 1 },
  ])
  await batch([
    { type: 'set', node_id: 3, element: input('app replacement'), expected_input_revision: 0 },
  ])
  await rejected(
    {
      type: 'batch',
      window_id: 1,
      base_revision: revision,
      operations: [
        { type: 'set', node_id: 3, element: input('stale'), expected_input_revision: 0 },
      ],
    },
    'stale_revision'
  )
  await batch([
    { type: 'delete', node_id: 2 },
    { type: 'delete', node_id: 7 },
  ])
  await rejected(
    {
      type: 'batch',
      window_id: 1,
      base_revision: revision,
      operations: [{ type: 'set', node_id: 4, element: text('deleted') }],
    },
    'invalid_handle'
  )
  await running.send({ type: 'close', window_id: 2 })
  assert.deepEqual(await events.next(), {
    done: false,
    value: { type: 'closed', window_id: 2, sequence: 1 },
  })
  await rejected(
    { type: 'open', window_id: 2, root_id: 8, title: 'Reuse must fail', width: 320, height: 240 },
    'invalid_handle'
  )
  await running.send({
    type: 'open',
    window_id: 3,
    root_id: 8,
    title: 'Fresh IDs work',
    width: 320,
    height: 240,
  })
  await running.send({ type: 'close', window_id: 3 })
  assert.deepEqual(await events.next(), {
    done: false,
    value: { type: 'closed', window_id: 3, sequence: 2 },
  })
  await Bun.sleep(150)

  const count = 1000
  const first = 9
  for (let offset = 0; offset < count; offset += 128) {
    const operations: Operation[] = []
    for (let index = 0; index < Math.min(128, count - offset); index++)
      operations.push(
        {
          type: 'create',
          node_id: first + offset + index,
          element: text(`Node ${offset + index}`),
        },
        { type: 'insert', parent_id: 1, child_id: first + offset + index, index: offset + index }
      )
    await batch(operations)
  }
  await Bun.sleep(150)
  for (let index = 0; index < 20; index++)
    await batch([{ type: 'set', node_id: first, element: text(`warm ${index}`) }])
  for (let index = 0; index < count; index++) {
    const operations: Operation[] = [
      { type: 'set', node_id: first + index, element: text(`single ${index}`) },
    ]
    const now = performance.now()
    await batch(operations)
    individual.push(performance.now() - now)
  }
  for (let offset = 0; offset < count; offset += 100) {
    const operations: Operation[] = Array.from({ length: 100 }, (_, index) => ({
      type: 'set',
      node_id: first + offset + index,
      element: text(`batch ${offset + index}`),
    }))
    const now = performance.now()
    await batch(operations)
    batched.push(performance.now() - now)
  }
  for (let offset = 0; offset < count; offset += 256)
    await batch(
      Array.from({ length: Math.min(256, count - offset) }, (_, index) => ({
        type: 'delete',
        node_id: first + offset + index,
      }))
    )
  await Bun.sleep(150)
  for (let index = 0; index < count; index++) {
    const node_id = first + count + index
    await batch([
      { type: 'create', node_id, element: input('') },
      { type: 'insert', parent_id: 1, child_id: node_id, index: 0 },
    ])
    await batch([
      { type: 'set', node_id, element: input(`cycle ${index}`), expected_input_revision: 0 },
    ])
    await batch([{ type: 'delete', node_id }])
  }
  await Bun.sleep(250)
  await running.send({ type: 'close', window_id: 1 })
  assert.deepEqual(await events.next(), {
    done: false,
    value: { type: 'closed', window_id: 1, sequence: 3 },
  })
  result['semanticChecks'] = [
    'cross-window handles',
    'cycle/orphan rejection',
    'failed batch revision/ID rollback',
    'stale input revision',
    'subtree revocation',
    'closed-window ID reuse',
    'other-window continued use',
    'global UI sequence',
  ]
  result['status'] = 'passed'
} catch (error) {
  failure = error
} finally {
  if (host) {
    try {
      await host.shutdown()
      assert.equal(await host.exited, 0)
      result['nativeExitCode'] = 0
    } catch (error) {
      failure ??= error
    }
  }
  result['totalWorkloadMs'] = performance.now() - started
  result['individual'] = distribution(individual)
  result['batchesOf100'] = distribution(batched)
  if (failure) {
    result['status'] = 'failed'
    result['error'] = String(failure)
  }
  if (values.instrument)
    result['nativeEvidence'] = {
      file: 'native-events.jsonl',
      nonce,
      preflightTiming:
        'batch_applied.preflight_nanos; includes validation and candidate graph clone, excludes GPUI apply/render',
    }
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(
  JSON.stringify({
    status: result['status'],
    individual: { ...distribution(individual), samplesMs: undefined },
    batchesOf100: { ...distribution(batched), samplesMs: undefined },
    output,
  })
)
if (failure) throw failure
