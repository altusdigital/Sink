import type { H3Event } from 'h3'
import type { Link } from '../../shared/schemas/link'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLinks, getLink } from '../../server/utils/link-store'

const mocks = vi.hoisted(() => ({
  d1CreateLinks: vi.fn(),
  d1GetActiveLink: vi.fn(),
  d1GetActiveLinkVersions: vi.fn(),
  d1HasActiveLinkVersion: vi.fn(),
  deleteLinkCache: vi.fn(),
  putLinkCache: vi.fn(),
  readLegacyKvLink: vi.fn(),
  readCompletedLinkMigrationMarker: vi.fn(),
}))

vi.mock('../../server/services/link-store/d1', () => ({
  d1CountLinks: vi.fn(),
  d1CreateLink: vi.fn(),
  d1CreateLinks: mocks.d1CreateLinks,
  d1DeleteLink: vi.fn(),
  d1GetActiveLink: mocks.d1GetActiveLink,
  d1GetActiveLinkVersions: mocks.d1GetActiveLinkVersions,
  d1GetAnyLink: vi.fn(),
  d1GetLinkWithMetadata: vi.fn(),
  d1HasActiveLinkVersion: mocks.d1HasActiveLinkVersion,
  d1IterateAllLinks: vi.fn(),
  d1ListLinks: vi.fn(),
  d1ListTags: vi.fn(),
  d1SearchLinks: vi.fn(),
  d1UpdateLink: vi.fn(),
}))

vi.mock('../../server/services/link-store/kv', () => ({
  deleteLinkCache: mocks.deleteLinkCache,
  isActiveLinkExpiration: () => true,
  putLinkCache: mocks.putLinkCache,
  readLegacyKvLink: mocks.readLegacyKvLink,
}))

vi.mock('../../server/services/link-store/migration', () => ({
  insertMigratedKvLink: vi.fn(),
  readCompletedLinkMigrationMarker: mocks.readCompletedLinkMigrationMarker,
}))

describe('createLinks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('keeps D1 success when post-write cache verification fails', async () => {
    const link: Link = {
      id: 'bulk-id',
      slug: 'bulk-success',
      url: 'https://example.com',
      createdAt: 1,
      updatedAt: 1,
      tags: [],
    }
    mocks.d1CreateLinks.mockResolvedValue([{ created: true, effectiveExpiresAt: null }])
    mocks.putLinkCache.mockResolvedValue(true)
    mocks.d1GetActiveLinkVersions.mockRejectedValue(new Error('version query failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(createLinks({} as H3Event, [link])).resolves.toEqual([{ created: true }])

    expect(mocks.d1CreateLinks).toHaveBeenCalledOnce()
    expect(mocks.deleteLinkCache).toHaveBeenCalledWith(expect.anything(), link.slug)
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ operation: 'bulk-write-through' }))
  })
})

describe('getLink', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  const event = { context: { cloudflare: { env: {} } } } as H3Event
  const link: Link = {
    id: 'redirect-id',
    slug: 'reliable-redirect',
    url: 'https://example.com/landing',
    createdAt: 1,
    updatedAt: 1,
    tags: [],
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.readLegacyKvLink.mockResolvedValue({ link: null, metadata: null })
    mocks.readCompletedLinkMigrationMarker.mockResolvedValue({ version: 1 })
    mocks.d1GetActiveLink.mockResolvedValue({ link, effectiveExpiresAt: null })
    mocks.putLinkCache.mockResolvedValue(true)
    mocks.d1HasActiveLinkVersion.mockResolvedValue(true)
    mocks.deleteLinkCache.mockResolvedValue(undefined)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it('keeps a valid KV hit independent of D1 availability', async () => {
    mocks.readLegacyKvLink.mockResolvedValue({ link, metadata: null })
    mocks.readCompletedLinkMigrationMarker.mockRejectedValue(new Error('D1 unavailable'))

    await expect(getLink(event, link.slug, 60)).resolves.toEqual(link)

    expect(mocks.readLegacyKvLink).toHaveBeenCalledWith(event, link.slug, 60)
    expect(mocks.readCompletedLinkMigrationMarker).not.toHaveBeenCalled()
    expect(mocks.d1GetActiveLink).not.toHaveBeenCalled()
  })

  it('falls back to migrated D1 when the KV read fails', async () => {
    mocks.readLegacyKvLink.mockRejectedValue(new Error('KV unavailable'))

    await expect(getLink(event, link.slug)).resolves.toEqual(link)

    expect(mocks.d1GetActiveLink).toHaveBeenCalledWith(event, link.slug)
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read', slug: link.slug }))
  })

  it('does not use partially migrated D1 after a failed legacy KV read', async () => {
    const kvError = new Error('legacy KV unavailable')
    mocks.readLegacyKvLink.mockRejectedValue(kvError)
    mocks.readCompletedLinkMigrationMarker.mockResolvedValue(null)

    await expect(getLink(event, link.slug)).rejects.toBe(kvError)

    expect(mocks.d1GetActiveLink).not.toHaveBeenCalled()
    expect(mocks.putLinkCache).not.toHaveBeenCalled()
  })

  it('keeps a pre-migration cache miss from reading partially migrated D1', async () => {
    mocks.readCompletedLinkMigrationMarker.mockResolvedValue(null)

    await expect(getLink(event, link.slug)).resolves.toBeNull()

    expect(mocks.d1GetActiveLink).not.toHaveBeenCalled()
  })

  it('does not revive a missing or expired D1 link during a KV outage', async () => {
    mocks.readLegacyKvLink.mockRejectedValue(new Error('KV unavailable'))
    mocks.d1GetActiveLink.mockResolvedValue(null)

    await expect(getLink(event, link.slug)).resolves.toBeNull()

    expect(mocks.putLinkCache).not.toHaveBeenCalled()
  })

  it('serves the D1 link when the cache write reports a handled KV failure', async () => {
    mocks.putLinkCache.mockResolvedValue(false)

    await expect(getLink(event, link.slug)).resolves.toEqual(link)

    expect(mocks.d1HasActiveLinkVersion).not.toHaveBeenCalled()
  })

  it('evicts an uncertain cache fill and fails when D1 cannot verify its version', async () => {
    const verificationError = new Error('D1 version query failed')
    mocks.d1HasActiveLinkVersion.mockRejectedValue(verificationError)

    await expect(getLink(event, link.slug)).rejects.toBe(verificationError)

    expect(mocks.deleteLinkCache).toHaveBeenCalledWith(event, link.slug)
  })

  it('evicts a cache fill when its link was changed or deleted during the read', async () => {
    mocks.d1HasActiveLinkVersion.mockResolvedValue(false)

    await expect(getLink(event, link.slug)).resolves.toEqual(link)

    expect(mocks.deleteLinkCache).toHaveBeenCalledWith(event, link.slug)
  })
})
