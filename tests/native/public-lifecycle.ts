import { createApplication, type NativeApplication, type NativeWindow } from '@bun-native/core'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { recordEvidence } from '../../examples/native-window/content.ts'

/**
 * Actual native public-API fixture for #229. The independent input driver must
 * click once, wait for the completed native paint, then close through the OS.
 * Its report supplies process-tree RSS, artifact/source provenance and dev/AOT
 * qualification. This fixture measures ownership and Bun memory; it does not
 * infer presentation latency, physical input, allocation counts or leak freedom.
 */
const CYCLES = 1_000
const DEADLINE_MS = 45_000
const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the prebuilt native host')

type Diagnostics = NativeApplication['diagnostics']
type Checkpoint = {
  phase: string
  completedCycles: number
  elapsedMs: number
  forcedGc: boolean
  memory: ReturnType<typeof process.memoryUsage>
  ownership: Diagnostics
  observedLiveCycleCallbacks: number
  observedLiveSubtreeHandles: number
  observedLiveLaunchCallback: boolean | null
}

const startedAt = new Date().toISOString()
const started = performance.now()
const durationsMs: number[] = []
const checkpoints: Checkpoint[] = []
const callbackReferences: WeakRef<object>[] = []
const subtreeReferences: WeakRef<object>[] = []
let launchReference: WeakRef<object> | undefined
const peakOwnership: Record<keyof Diagnostics, number> = {
  windows: 0,
  nodes: 0,
  callbacks: 0,
  queuedTransactions: 0,
  queuedCallbacks: 0,
  activeCallbacks: 0,
}
let completedCycles = 0
let callbackRegistrations = 0
let unexpectedCallbacks = 0
let launchAborted = false
let launchInvocations = 0
let workloadMs: number | undefined
let failure: Error | undefined
const app = await createApplication({ executable: resolve(executable) })

function fail(cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  failure ??= error
  return error
}

function observe(): Diagnostics {
  const current = app.diagnostics
  for (const key of Object.keys(peakOwnership) as (keyof Diagnostics)[])
    peakOwnership[key] = Math.max(peakOwnership[key], current[key])
  assert(current.windows <= 1, 'The fixture owns only one native window')
  assert(current.nodes <= 8, 'Disposed subtrees must not accumulate')
  assert(current.callbacks <= 3, 'Listener replacement must not accumulate registrations')
  assert(
    current.queuedTransactions <= 1,
    'The sequential workload must not grow a transaction queue'
  )
  assert.equal(current.queuedCallbacks, 0, 'Only the one injected launch click is expected')
  assert(current.activeCallbacks <= 1, 'Application callbacks must remain serialized')
  return current
}

function countLive(references: readonly WeakRef<object>[]): number {
  return references.reduce((count, reference) => count + Number(reference.deref() !== undefined), 0)
}

async function checkpoint(phase: string, forcedGc = false): Promise<void> {
  if (forcedGc) {
    // WeakRef observations keep their targets alive for the current job. Yield
    // before collection so an earlier checkpoint cannot pin all sampled objects.
    await Bun.sleep(0)
    Bun.gc(true)
    await Bun.sleep(0)
  }
  checkpoints.push({
    phase,
    completedCycles,
    elapsedMs: performance.now() - started,
    forcedGc,
    memory: process.memoryUsage(),
    ownership: observe(),
    observedLiveCycleCallbacks: countLive(callbackReferences),
    observedLiveSubtreeHandles: countLive(subtreeReferences),
    observedLiveLaunchCallback: launchReference ? launchReference.deref() !== undefined : null,
  })
}

async function exercise(window: NativeWindow): Promise<void> {
  await checkpoint('before-cycles', true)
  const workloadStarted = performance.now()
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const cycleStarted = performance.now()
    const nodes = await window.batch((batch) => {
      observe()
      const group = batch.create({ kind: 'box' })
      const label = batch.create({ kind: 'text', text: `Cycle ${cycle}` })
      const button = batch.create({ kind: 'button', text: 'Transient button' })
      const input = batch.create({ kind: 'input', value: '' })
      for (const child of [label, button, input]) batch.append(group, child)
      batch.append(window.root, group)
      return { group, label, button, input }
    })
    subtreeReferences.push(new WeakRef(nodes.group))
    assert.equal(observe().nodes, 8)

    const previousClick = () => {
      unexpectedCallbacks += 1
    }
    const currentClick = () => {
      unexpectedCallbacks += 1
    }
    const currentInput = () => {
      unexpectedCallbacks += 1
    }
    callbackReferences.push(
      new WeakRef(previousClick),
      new WeakRef(currentClick),
      new WeakRef(currentInput)
    )
    const unsubscribePrevious = window.onClick(nodes.button, previousClick)
    assert.equal(observe().callbacks, 2)
    const unsubscribeClick = window.onClick(nodes.button, currentClick)
    unsubscribePrevious()
    assert.equal(observe().callbacks, 2, 'An old unsubscribe must preserve its replacement')
    const unsubscribeInput = window.onInput(nodes.input, currentInput)
    assert.equal(observe().callbacks, 3)
    callbackRegistrations += 3

    await window.batch((batch) => {
      observe()
      batch.set(nodes.label, { kind: 'text', text: `Updated ${cycle}` })
      batch.set(
        nodes.input,
        { kind: 'input', value: `Value ${cycle}` },
        window.input(nodes.input).revision
      )
    })
    assert.deepEqual(window.input(nodes.input), { value: `Value ${cycle}`, revision: 1 })
    await window.batch((batch) => {
      observe()
      batch.remove(nodes.group)
    })
    // Automatic subtree disposal revokes both current listeners. Their original
    // unsubscribe closures must also remain safe to call repeatedly afterwards.
    unsubscribeClick()
    unsubscribeClick()
    unsubscribeInput()
    assert.deepEqual(observe(), {
      windows: 1,
      nodes: 4,
      callbacks: 1,
      queuedTransactions: 0,
      queuedCallbacks: 0,
      activeCallbacks: 1,
    })
    assert.equal(unexpectedCallbacks, 0)
    durationsMs.push(performance.now() - cycleStarted)
    completedCycles += 1
    if (completedCycles % 100 === 0) await checkpoint('cycles')
  }
  workloadMs = performance.now() - workloadStarted
  await checkpoint('after-cycles-before-gc')
  await checkpoint('after-cycles-after-gc', true)
}

const deadline = setTimeout(() => {
  fail(new Error(`Public lifecycle fixture exceeded ${DEADLINE_MS} ms`))
  void app.shutdown().catch(fail)
}, DEADLINE_MS)

try {
  const window = await app.openWindow({
    title: 'Bun Native public lifecycle',
    width: 560,
    height: 380,
  })
  const { status, startButton } = await window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: { direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 },
    })
    const heading = batch.create({
      kind: 'text',
      text: 'Public lifecycle',
      style: { font_size: 28 },
    })
    const status = batch.create({ kind: 'text', text: 'Ready' })
    const startButton = batch.create({
      kind: 'button',
      text: 'Run 1,000 cycles',
      style: { width: 200, height: 44 },
    })
    for (const node of [heading, status, startButton]) batch.append(window.root, node)
    return { status, startButton }
  })
  // Keep this declaration in a nested scope: retaining the listener in a module
  // binding would make its post-disposal WeakRef observation meaningless.
  {
    const listener: Parameters<NativeWindow['onClick']>[1] = async (event) => {
      try {
        launchInvocations += 1
        assert.equal(launchInvocations, 1)
        assert.equal(event.sequence, 1)
        event.signal.addEventListener(
          'abort',
          () => {
            launchAborted = true
          },
          { once: true }
        )
        recordEvidence({ type: 'click', sequence: event.sequence, target: 'public-lifecycle' })
        await exercise(window)
        await window.batch((batch) => {
          observe()
          batch.set(status, { kind: 'text', text: `Completed ${CYCLES} cycles` })
        })
        assert.equal(window.revision, CYCLES * 3 + 2)
        await checkpoint('waiting-for-os-close')
        // Deliberately unresolved application work. OS-close ingestion must
        // still revoke this listener and release dispatch without awaiting it.
        await new Promise<void>(() => {})
      } catch (cause) {
        throw fail(cause)
      }
    }
    launchReference = new WeakRef(listener)
    window.onClick(startButton, listener)
  }
  await window.closed
  assert.equal(completedCycles, CYCLES)
  assert.equal(launchAborted, true, 'OS close must abort the active listener registration')
} catch (cause) {
  fail(cause)
}

clearTimeout(deadline)
try {
  await app.shutdown()
  await app.closed
  assert.deepEqual(observe(), {
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
  })
  await checkpoint('after-shutdown-before-gc')
  await checkpoint('after-shutdown-after-gc', true)
} catch (cause) {
  fail(cause)
}

const sorted = [...durationsMs].sort((left, right) => left - right)
const percentile = (fraction: number) =>
  sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
const result = {
  schemaVersion: 1,
  status: failure ? 'failed' : 'passed',
  startedAt,
  elapsedMs: performance.now() - started,
  runtime: { bunVersion: Bun.version, bunRevision: Bun.revision, executable: process.execPath },
  platform: { os: platform(), architecture: arch(), kernel: release() },
  nativeHost: {
    executable: resolve(executable),
    declaredProfile: process.env['BUN_NATIVE_HOST_PROFILE'],
  },
  checks: {
    completedCycles,
    callbackRegistrations,
    callbackReplacements: completedCycles,
    disposedSubtrees: completedCycles,
    launchInvocations,
    launchAborted,
    unexpectedCallbacks,
    finalOwnership: app.diagnostics,
    peakOwnership,
  },
  cycleAcknowledgement: {
    count: durationsMs.length,
    workloadMs,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    samplesMs: durationsMs,
  },
  memory: {
    methodology:
      'Bun process.memoryUsage checkpoints; forced Bun.gc(true) only at labelled phases; WeakRef counts are observations, not GC guarantees. Instrumentation retains 3000 callback WeakRefs, 1000 subtree WeakRefs, checkpoints and timing samples.',
    checkpoints,
  },
  scope: {
    exercised:
      'One real OS launch click, native subtree create/update/dispose, listener replacement/removal, and OS-close cancellation of an unresolved application callback.',
    cycleTiming:
      'Public API create/update/delete acknowledgements plus listener bookkeeping and assertions; excludes presentation and OS input latency.',
    callbackRetention:
      'Public strong-ownership counts are asserted after every cycle. WeakRef reachability after forced GC is reported separately.',
    externalEvidence:
      'The independent native input driver and build manifest establish source/artifact identity, actual paint, OS input, process-tree RSS and development/AOT mode.',
    notEstablished: [
      'Complete allocation counts or an allocation profile',
      'High-frequency OS event throughput or dispatch-latency distribution',
      'Long-running native, GPU or JavaScript leak freedom',
      'AOT compilation or JIT removal from this fixture alone',
    ],
  },
  error: failure ? { name: failure.name, message: failure.message } : undefined,
}
const json = JSON.stringify(result, null, 2) + '\n'
const evidenceLog = process.env['BUN_NATIVE_EVIDENCE_LOG']
if (evidenceLog)
  writeFileSync(join(dirname(evidenceLog), 'public-lifecycle.json'), json, { flag: 'wx' })
console.log(json)
if (failure) throw failure
