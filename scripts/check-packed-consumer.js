import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { isExactIntegrity, isExactVersion, packageRepositories } from './release-manifest.js'

const repositories = packageRepositories
const runtimeRepositories = repositories.filter((repository) => repository !== 'contracts')

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const buildToolPath = path.join(projectRoot, 'node_modules', '.bin')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const publishedVersions = parsePublishedVersions(process.env.AUTHMODULES_PUBLISHED_VERSIONS)
const publishedIntegrities = parsePublishedIntegrities(process.env.AUTHMODULES_PUBLISHED_INTEGRITIES)
if ((publishedVersions === undefined) !== (publishedIntegrities === undefined)) {
  throw new Error('Published versions and integrities must be provided together')
}
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'authmodules-packed-consumer-'))
const tarballRoot = path.join(temporaryRoot, 'tarballs')
const consumerRoot = path.join(temporaryRoot, 'consumer')

try {
  await mkdir(tarballRoot)
  await mkdir(consumerRoot)
  let installTargets

  if (publishedVersions) {
    installTargets = repositories.map((repository) => (
      `@authmodules/${repository}@${publishedVersions[repository]}`
    ))
  } else {
    const tarballs = []
    for (const repository of repositories) {
      const repositoryPath = path.join(workspaceRoot, repository)
      await run(npm, ['run', 'build', '--ignore-scripts'], repositoryPath)
      const before = new Set(await readdir(tarballRoot))
      await run(npm, [
        'pack',
        '--silent',
        '--ignore-scripts',
        '--pack-destination',
        tarballRoot
      ], repositoryPath)
      const created = (await readdir(tarballRoot)).filter((entry) => !before.has(entry) && entry.endsWith('.tgz'))
      if (created.length !== 1) throw new Error(`${repository} pack must create exactly one tarball`)
      tarballs.push(path.join(tarballRoot, created[0]))
    }
    installTargets = tarballs
  }

  await writeFile(path.join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'authmodules-packed-consumer',
    version: '0.0.0',
    private: true,
    type: 'module'
  }, null, 2))

  const installMode = publishedVersions ? ['--prefer-online'] : ['--offline']
  const install = () => run(npm, [
    'install',
    ...installMode,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    ...installTargets
  ], consumerRoot)
  if (publishedVersions) {
    await retry(install, { attempts: 6, delayMilliseconds: 10_000 })
  } else {
    await install()
  }

  await assertPublishedPackages(consumerRoot, publishedVersions)
  if (publishedVersions && publishedIntegrities) {
    await assertPublishedIntegrities(publishedVersions, publishedIntegrities)
  }

  await writeFile(path.join(consumerRoot, 'consumer.js'), runtimeConsumerSource())
  await writeFile(path.join(consumerRoot, 'consumer.ts'), typeConsumerSource())
  await writeFile(path.join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false
    },
    include: ['consumer.ts']
  }, null, 2))

  await run(process.execPath, ['consumer.js'], consumerRoot)
  await run(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    path.join(consumerRoot, 'tsconfig.json')
  ], consumerRoot)

  console.log(publishedVersions ? 'Published consumer passed' : 'Packed consumer passed')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function assertPublishedPackages(consumerDirectory, expectedVersions) {
  for (const repository of repositories) {
    const manifest = JSON.parse(await readFile(path.join(
      consumerDirectory,
      'node_modules',
      '@authmodules',
      repository,
      'package.json'
    ), 'utf8'))
    if (expectedVersions && manifest.version !== expectedVersions[repository]) {
      throw new Error(`${repository} resolved ${manifest.version} instead of ${expectedVersions[repository]}`)
    }
  }
  for (const repository of runtimeRepositories) {
    const packageRoot = path.join(consumerDirectory, 'node_modules', '@authmodules', repository)
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    if (manifest.main !== './dist/index.js' || manifest.exports?.['.']?.import !== './dist/index.js') {
      throw new Error(`${repository} must publish standard ESM from dist/index.js`)
    }
    if (manifest.types !== './dist/index.d.ts' || manifest.exports?.['.']?.types !== './dist/index.d.ts') {
      throw new Error(`${repository} must publish types from dist/index.d.ts`)
    }

    const declarationEntry = path.join(packageRoot, manifest.types)
    const declarations = await readPublicDeclarations(declarationEntry)
    if (/\bany\b/.test(declarations)) {
      throw new Error(`${repository} public declarations must not contain any`)
    }

    const runtimeEntry = path.join(packageRoot, manifest.main)
    const runtime = await import(`${pathToFileURL(runtimeEntry).href}?packed=${Date.now()}`)
    for (const name of Object.keys(runtime)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const declared = new RegExp(`\\b(?:function|const|class)\\s+${escaped}\\b`).test(declarations)
        || new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(declarations)
      if (!declared) {
        throw new Error(`${repository} runtime export ${name} is missing from public declarations`)
      }
    }
  }
}

async function readPublicDeclarations(entry, visited = new Set()) {
  if (visited.has(entry)) return ''
  visited.add(entry)
  const declaration = await readFile(entry, 'utf8')
  const children = await Promise.all([...declaration.matchAll(/export(?:\s+type)?\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => {
      const target = specifier.endsWith('.d.ts') ? specifier : specifier.replace(/\.(?:[cm]?ts|[cm]?js)$/, '.d.ts')
      return readPublicDeclarations(path.resolve(path.dirname(entry), target), visited)
    }))
  return [declaration, ...children].join('\n')
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        PATH: `${buildToolPath}${path.delimiter}${process.env.PATH ?? ''}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout)
      reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stdout}${stderr}`))
    })
  })
}

function parsePublishedVersions(source) {
  if (source === undefined) return undefined
  const trimmed = source.trim()
  if (trimmed.length === 0) return undefined

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('AUTHMODULES_PUBLISHED_VERSIONS must be a JSON object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUTHMODULES_PUBLISHED_VERSIONS must be a JSON object')
  }
  const keys = Object.keys(parsed)
  if (keys.length !== repositories.length || keys.some((repository) => !repositories.includes(repository))) {
    throw new Error('AUTHMODULES_PUBLISHED_VERSIONS must name every package repository exactly once')
  }
  for (const repository of repositories) {
    const version = parsed[repository]
    if (!isExactVersion(version)) {
      throw new Error(`${repository} must use an exact package version`)
    }
  }
  return Object.freeze({ ...parsed })
}

function parsePublishedIntegrities(source) {
  if (source === undefined) return undefined
  const trimmed = source.trim()
  if (trimmed.length === 0) return undefined

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('AUTHMODULES_PUBLISHED_INTEGRITIES must be a JSON object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUTHMODULES_PUBLISHED_INTEGRITIES must be a JSON object')
  }
  const keys = Object.keys(parsed)
  if (keys.length !== repositories.length || keys.some((repository) => !repositories.includes(repository))) {
    throw new Error('AUTHMODULES_PUBLISHED_INTEGRITIES must name every package repository exactly once')
  }
  for (const repository of repositories) {
    if (!isExactIntegrity(parsed[repository])) {
      throw new Error(`${repository} must use an exact package integrity`)
    }
  }
  return Object.freeze({ ...parsed })
}

async function assertPublishedIntegrities(versions, expectedIntegrities) {
  for (const repository of repositories) {
    const packageSpec = `@authmodules/${repository}@${versions[repository]}`
    const resolveIntegrity = async () => {
      const stdout = await run(npm, [
        'view',
        packageSpec,
        'dist.integrity',
        '--json',
        '--registry=https://npm.pkg.github.com'
      ], consumerRoot)
      const integrity = JSON.parse(stdout)
      if (!isExactIntegrity(integrity)) {
        throw new Error(`${packageSpec} registry metadata does not contain one SHA-512 integrity`)
      }
      return integrity
    }
    const actual = await retry(resolveIntegrity, { attempts: 6, delayMilliseconds: 5_000 })
    if (actual !== expectedIntegrities[repository]) {
      throw new Error(`${packageSpec} registry integrity does not match the release plan`)
    }
  }
}

async function retry(operation, options) {
  let lastError
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === options.attempts) break
      await new Promise((resolve) => setTimeout(resolve, options.delayMilliseconds))
    }
  }
  throw lastError
}

function runtimeConsumerSource() {
  return `
const requiredExports = {
  '@authmodules/carrier-cookie': ['createCookieTokenCarrier'],
  '@authmodules/core': ['createAuth'],
  '@authmodules/crypto-node': ['createNodeCryptoProvider'],
  '@authmodules/delivery-email-smtp': ['createSmtpDeliveryTransport'],
  '@authmodules/effects-outbox': ['createOutboxEffectsDispatcher'],
  '@authmodules/effects-sync-delivery': ['createSyncDeliveryEffects'],
  '@authmodules/framework-express': ['createExpressAuthAdapter'],
  '@authmodules/guard-memory': ['createMemoryAttemptGuard'],
  '@authmodules/method-otp': ['createOtpMethod'],
  '@authmodules/method-password': ['createPasswordMethod'],
  '@authmodules/outbox-worker': ['createOutboxWorker'],
  '@authmodules/store-postgres': ['createPostgresAuthStore', 'postgresSchemaSql'],
  '@authmodules/testkit': ['createMemoryAuthOutboxStores', 'createMemoryAuthStore', 'runComplianceSuite'],
  '@authmodules/token-opaque': ['createOpaqueTokenFormat']
}

for (const [packageName, names] of Object.entries(requiredExports)) {
  const loaded = await import(packageName)
  for (const name of names) {
    if (!(name in loaded)) throw new Error(\`\${packageName} is missing \${name}\`)
  }
}

const { createAuth } = await import('@authmodules/core')
const {
  createNodeCryptoProvider,
  createNodePasswordHasher,
  createNodeSecretSealer,
  rawSecret
} = await import('@authmodules/crypto-node')
const { createSmtpDeliveryTransport } = await import('@authmodules/delivery-email-smtp')
const { createOutboxEffectsDispatcher } = await import('@authmodules/effects-outbox')
const { createSyncDeliveryEffects } = await import('@authmodules/effects-sync-delivery')
const { createOtpMethod } = await import('@authmodules/method-otp')
const { createPasswordMethod } = await import('@authmodules/method-password')
const { createOutboxWorker } = await import('@authmodules/outbox-worker')
const {
  createMemoryAuthOutboxStores,
  createMemoryAuthStore,
  createMemoryOutboxStore,
  deterministicIdGenerator,
  fixedClock
} = await import('@authmodules/testkit')
const { createOpaqueTokenFormat } = await import('@authmodules/token-opaque')

await verifyPasswordStack()
await verifyOtpStack()
await verifyOutboxStack()

async function verifyPasswordStack() {
  const clock = fixedClock(new Date('2026-01-01T00:00:00.000Z'))
  const crypto = createNodeCryptoProvider()
  const method = createPasswordMethod({
    passwordHasher: createNodePasswordHasher({ iterations: 600_000, keyLength: 32 })
  })
  const auth = configuredAuth({ clock, crypto, methods: { [method.methodId]: method } })
  const password = rawSecret('correct horse battery staple')
  const enrolled = await auth.enroll({
    context: { tenantId: 'packed_password' },
    methodId: method.methodId,
    input: { subject: ' User@Example.TEST ', password },
    account: { mode: 'create-new-account' },
    session: {}
  })
  ensure(enrolled.ok, 'packed password enrollment failed')
  ensure(enrolled.value.identity.subject === 'user@example.test', 'password subject was not canonicalized')
  ensure(!JSON.stringify(enrolled.value).includes(password.reveal()), 'password leaked into public result')

  const authenticated = await auth.authenticate({
    context: { tenantId: 'packed_password' },
    methodId: method.methodId,
    input: { subject: 'user@example.test', password },
    session: { ttlSeconds: 120 }
  })
  ensure(authenticated.ok, 'packed password authentication failed')
  ensure(authenticated.value.account.accountId === enrolled.value.account.accountId, 'password account changed')
}

async function verifyOtpStack() {
  const clock = fixedClock(new Date('2026-01-01T00:00:00.000Z'))
  const crypto = createNodeCryptoProvider()
  const stores = createMemoryAuthOutboxStores()
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(6)),
    keyId: 'packed-otp-outbox'
  })
  let deliveredCode
  let deliveredTo
  const transport = createSmtpDeliveryTransport({
    now: () => clock.now(),
    from: 'no-reply@example.test',
    render({ message }) {
      return { subject: 'Your sign-in code', text: message.data.code.reveal() }
    },
    client: {
      async sendMail(input) {
        deliveredTo = input.to
        deliveredCode = input.text
        return { providerMessageId: 'packed_smtp', acceptedAt: clock.now() }
      }
    }
  })
  const method = createOtpMethod({
    crypto,
    verificationKey: rawSecret(new Uint8Array(32).fill(5)),
    codeLength: 6
  })
  const auth = configuredAuth({
    clock,
    crypto,
    methods: { [method.methodId]: method },
    effects: createOutboxEffectsDispatcher({
      store: stores.outbox,
      sealer,
      now: () => clock.now(),
      idGenerator: () => 'packed_otp_message'
    }),
    store: stores.auth
  })
  const begun = await auth.begin({
    context: { tenantId: 'packed_otp' },
    methodId: method.methodId,
    input: {
      subject: ' User@Example.TEST ',
      display: 'attacker@example.test',
      deliveryTarget: 'attacker@example.test'
    },
    account: { mode: 'create-account-if-identity-missing' },
    session: {}
  })
  ensure(begun.ok, 'packed OTP begin failed')
  ensure(deliveredCode === undefined, 'OTP was delivered before the outbox transaction committed')
  const delivery = await createOutboxWorker({
    store: stores.outbox,
    transport,
    sealer,
    workerId: 'packed_otp_worker'
  }).runOnce({ now: clock.now() })
  ensure(delivery.ok && delivery.value.dispatched === 1, 'packed OTP outbox delivery failed')
  ensure(deliveredTo === 'user@example.test', 'OTP delivery was not bound to canonical subject')
  ensure(typeof deliveredCode === 'string', 'OTP code was not delivered')

  const completed = await auth.complete({
    context: { tenantId: 'packed_otp' },
    challengeId: begun.value.challengeId,
    input: { code: rawSecret(deliveredCode) }
  })
  ensure(completed.ok, 'packed OTP completion failed')
  ensure(completed.value.proof.primaryIdentity.subject === 'user@example.test', 'OTP proof subject changed')
}

async function verifyOutboxStack() {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const store = createMemoryOutboxStore()
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(7)),
    keyId: 'packed-outbox'
  })
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer,
    now: () => new Date(now.getTime()),
    idGenerator: () => 'packed_message'
  })
  const queued = await dispatcher.dispatch({
    context: { tenantId: 'packed_outbox' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'otp:packed_challenge',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: { code: rawSecret('123456') }
      }
    }]
  })
  ensure(queued.ok, 'packed outbox dispatch failed')

  let delivery
  const worker = createOutboxWorker({
    store,
    sealer,
    workerId: 'packed_worker',
    transport: {
      async send(input) {
        delivery = input
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })
  const result = await worker.runOnce({ now })
  ensure(result.ok && result.value.dispatched === 1, 'packed outbox worker did not dispatch')
  ensure(delivery.idempotencyKey === 'otp:packed_challenge', 'outbox idempotency key was not preserved')
  ensure(delivery.message.data.code.reveal() === '123456', 'outbox secret was not restored')
}

function configuredAuth({ clock, crypto, methods, effects, store = createMemoryAuthStore() }) {
  const result = createAuth({
    clock,
    idGenerator: deterministicIdGenerator('packed'),
    store,
    methods,
    effects,
    token: createOpaqueTokenFormat({ crypto }),
    session: { defaultTtlSeconds: 3600, maxTtlSeconds: 7200 }
  })
  ensure(result.ok, 'packed auth configuration failed')
  return result.value
}

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}
`
}

function typeConsumerSource() {
  return `
import type {
  Auth,
  AuthGuard,
  AuthStore,
  CreateSessionRequest,
  DispatchContext,
  IssuedTokenView,
  RecordFailedAttemptResult,
  TokenFormat,
  TokenIdentifyResult,
  TokenIssueResult,
  TransactionRunner
} from '@authmodules/contracts'
import type { SecretHttpValue } from '@authmodules/contracts/carrier'
import type { OutboxStore } from '@authmodules/contracts/extensions'
import type { AuthContext } from '@authmodules/contracts/primitives'
import type { RawSecretValue } from '@authmodules/contracts/security'
import { createCookieTokenCarrier } from '@authmodules/carrier-cookie'
import { createAuth } from '@authmodules/core'
import { createNodeCryptoProvider } from '@authmodules/crypto-node'
import { createSmtpDeliveryTransport } from '@authmodules/delivery-email-smtp'
import { createOutboxEffectsDispatcher } from '@authmodules/effects-outbox'
import { createSyncDeliveryEffects } from '@authmodules/effects-sync-delivery'
import { createExpressAuthAdapter } from '@authmodules/framework-express'
import { createMemoryAttemptGuard } from '@authmodules/guard-memory'
import { createOtpMethod } from '@authmodules/method-otp'
import type { OtpMethod } from '@authmodules/method-otp'
import { createPasswordMethod } from '@authmodules/method-password'
import { createOutboxWorker } from '@authmodules/outbox-worker'
import { createPostgresAuthStore, postgresSchemaSql } from '@authmodules/store-postgres'
import { createMemoryAuthOutboxStores, createMemoryAuthStore, runComplianceSuite } from '@authmodules/testkit'
import { createOpaqueTokenFormat } from '@authmodules/token-opaque'

const context: AuthContext = { tenantId: 'tenant_1' }
type Assert<T extends true> = T
type RootContractExports = [
  Auth,
  AuthGuard,
  AuthStore,
  CreateSessionRequest,
  DispatchContext,
  IssuedTokenView,
  RecordFailedAttemptResult,
  TokenFormat,
  TokenIssueResult,
  TransactionRunner
]
type TokenIdentifyAllowsNull = Assert<null extends TokenIdentifyResult ? true : false>
type HeaderValuesAllowSecretParts = Assert<RawSecretValue<string> extends SecretHttpValue['parts'][number] ? true : false>
type ExtensionsExposeOutbox = Assert<OutboxStore extends object ? true : false>
type OtpFactoryKeepsRequiredOperations = Assert<ReturnType<typeof createOtpMethod> extends OtpMethod ? true : false>
const publicRuntimeValues = [
  createCookieTokenCarrier,
  createAuth,
  createNodeCryptoProvider,
  createSmtpDeliveryTransport,
  createOutboxEffectsDispatcher,
  createSyncDeliveryEffects,
  createExpressAuthAdapter,
  createMemoryAttemptGuard,
  createOtpMethod,
  createPasswordMethod,
  createOutboxWorker,
  createPostgresAuthStore,
  postgresSchemaSql,
  createMemoryAuthStore,
  createMemoryAuthOutboxStores,
  runComplianceSuite,
  createOpaqueTokenFormat
] as const

void context
void publicRuntimeValues
export type {
  ExtensionsExposeOutbox,
  HeaderValuesAllowSecretParts,
  OtpFactoryKeepsRequiredOperations,
  RootContractExports,
  TokenIdentifyAllowsNull
}
`
}
