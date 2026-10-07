import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'jsonc-parser'
import { unstable_readConfig as readWranglerConfig } from 'wrangler'

const run = promisify(execFile)
const rootDir = fileURLToPath(new URL('../', import.meta.url))
const requiredEnv = {
  DEPLOY_WORKER_NAME: 'sink-marketing-test',
  DEPLOY_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001',
  DEPLOY_KV_NAMESPACE_ID: '00000000000000000000000000000001',
  DEPLOY_R2_BUCKET_NAME: 'campaign-backup-test',
}

async function generate(env = {}, sourceChanges = {}, fileEnv = '') {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'sink-deploy-config-'))
  try {
    await mkdir(join(fixtureDir, 'scripts'))
    await copyFile(new URL('cloudflare-deploy-config.mjs', import.meta.url), join(fixtureDir, 'scripts/cloudflare-deploy-config.mjs'))
    await symlink(join(rootDir, 'node_modules'), join(fixtureDir, 'node_modules'), 'dir')
    const source = parse(await readFile(join(rootDir, 'wrangler.jsonc'), 'utf8'))
    const fixtureSource = { ...source, ...sourceChanges }
    await writeFile(join(fixtureDir, 'wrangler.jsonc'), JSON.stringify(fixtureSource))
    await writeFile(join(fixtureDir, '.env'), fileEnv)
    await run(process.execPath, [join(fixtureDir, 'scripts/cloudflare-deploy-config.mjs')], {
      env: { PATH: process.env.PATH, ...requiredEnv, ...env },
    })
    const output = await readFile(join(fixtureDir, 'wrangler.deploy.jsonc'), 'utf8')
    const validatedConfig = readWranglerConfig({ config: join(fixtureDir, 'wrangler.deploy.jsonc') }, { hideWarnings: true })
    const unchangedSource = JSON.parse(await readFile(join(fixtureDir, 'wrangler.jsonc'), 'utf8'))
    assert.deepEqual(unchangedSource, fixtureSource)
    return { config: JSON.parse(output), validatedConfig, output }
  }
  finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
}

test('generates marketing redirect and telemetry policy while preserving unrelated variables', async () => {
  const { config, validatedConfig, output } = await generate({
    DEPLOY_ANALYTICS_DATASET: 'campaign-test',
    NUXT_SITE_TOKEN: 'not-a-real-secret',
    NUXT_CF_API_TOKEN: 'not-a-real-api-token',
  }, {
    keep_vars: false,
    secrets: { required: ['EXISTING_SECRET'] },
    vars: { UNRELATED_SETTING: 'preserved', NUXT_REDIRECT_STATUS_CODE: '301', NUXT_DATASET: 'stale' },
    observability: { logs: { enabled: false }, traces: { enabled: true }, issues: { enabled: false } },
  })

  assert.equal(config.keep_vars, true)
  assert.equal(config.name, requiredEnv.DEPLOY_WORKER_NAME)
  assert.deepEqual(config.secrets.required, ['EXISTING_SECRET', 'NUXT_SITE_TOKEN', 'NUXT_CF_API_TOKEN'])
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.assets.run_worker_first, true)
  assert.equal(config.assets.binding, 'ASSETS')
  assert.deepEqual(config.triggers.crons, ['0 14 * * *'])
  assert.deepEqual(config.vars, {
    UNRELATED_SETTING: 'preserved',
    NUXT_REDIRECT_STATUS_CODE: '302',
    NUXT_DATASET: 'campaign-test',
    NUXT_REDIRECT_WITH_QUERY: 'true',
    NUXT_REDIRECT_NO_STORE: 'true',
    NUXT_LINK_CACHE_TTL: '60',
    NUXT_PUBLIC_LINK_PROXY_ENABLED: 'false',
    NUXT_DISABLE_BOT_ACCESS_LOG: 'true',
    NUXT_DISABLE_AUTO_BACKUP: 'false',
  })
  assert.equal(config.analytics_engine_datasets[0].dataset, config.vars.NUXT_DATASET)
  assert.equal(config.observability.enabled, true)
  assert.equal(config.observability.logs.enabled, true)
  assert.equal(config.observability.logs.head_sampling_rate, 1)
  assert.equal(config.observability.logs.invocation_logs, true)
  assert.equal(config.observability.logs.persist, true)
  assert.equal(config.observability.issues.enabled, true)
  assert.equal(config.observability.traces.enabled, false)
  assert.equal(config.observability.redact_query_string, true)
  assert.doesNotMatch(output, /not-a-real/)
  assert.equal(Object.hasOwn(config.vars, 'NUXT_SITE_TOKEN'), false)
  assert.equal(Object.hasOwn(config.vars, 'NUXT_CF_API_TOKEN'), false)
  assert.equal(validatedConfig.observability.issues.enabled, true)
  assert.equal(validatedConfig.observability.redact_query_string, true)
  assert.deepEqual(validatedConfig.secrets.required, config.secrets.required)
})

test('uses environment binding overrides and keeps R2 backup enabled', async () => {
  const { config } = await generate({
    DEPLOY_D1_DATABASE_NAME: 'campaign-db',
    DEPLOY_KV_PREVIEW_NAMESPACE_ID: '00000000000000000000000000000002',
    DEPLOY_R2_BUCKET_NAME: 'campaign-backup-test',
    DEPLOY_R2_PREVIEW_BUCKET_NAME: 'campaign-backup-preview-test',
    DEPLOY_ANALYTICS_DATASET: 'campaign-env',
  }, {}, 'DEPLOY_ANALYTICS_DATASET=campaign-file\n')

  assert.equal(config.d1_databases[0].database_id, requiredEnv.DEPLOY_D1_DATABASE_ID)
  assert.equal(config.d1_databases[0].database_name, 'campaign-db')
  assert.equal(config.kv_namespaces[0].id, requiredEnv.DEPLOY_KV_NAMESPACE_ID)
  assert.equal(config.kv_namespaces[0].preview_id, '00000000000000000000000000000002')
  assert.equal(config.r2_buckets[0].bucket_name, 'campaign-backup-test')
  assert.equal(config.r2_buckets[0].preview_bucket_name, 'campaign-backup-preview-test')
  assert.equal(config.vars.NUXT_DATASET, 'campaign-env')
})

test('uses preview binding fallbacks while retaining the required backup bucket', async () => {
  const { config } = await generate()

  assert.equal(config.kv_namespaces[0].preview_id, requiredEnv.DEPLOY_KV_NAMESPACE_ID)
  assert.equal(config.d1_databases[0].database_name, 'sink')
  assert.equal(config.vars.NUXT_DATASET, 'sink')
  assert.equal(config.r2_buckets[0].bucket_name, requiredEnv.DEPLOY_R2_BUCKET_NAME)
  assert.equal(config.r2_buckets[0].preview_bucket_name, requiredEnv.DEPLOY_R2_BUCKET_NAME)
})

test('requires an explicit Worker name, authoritative storage, and backup bucket', async () => {
  await assert.rejects(generate({ DEPLOY_WORKER_NAME: '' }), /DEPLOY_WORKER_NAME/)
  await assert.rejects(generate({ DEPLOY_D1_DATABASE_ID: '' }), /DEPLOY_D1_DATABASE_ID/)
  await assert.rejects(generate({ DEPLOY_KV_NAMESPACE_ID: '' }), /DEPLOY_KV_NAMESPACE_ID/)
  await assert.rejects(generate({ DEPLOY_R2_BUCKET_NAME: undefined }), /DEPLOY_R2_BUCKET_NAME/)
  await assert.rejects(generate({ DEPLOY_R2_BUCKET_NAME: '' }), /DEPLOY_R2_BUCKET_NAME/)
})
