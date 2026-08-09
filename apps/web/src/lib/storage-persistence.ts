/**
 * Storage persistence status (2026-08-09): `navigator.storage.persist()` in main.tsx used to be
 * fire-and-forget (`void navigator.storage.persist()`), which discards the one bit that actually
 * matters — browsers GRANT or DENY it on their own engagement heuristics (Firefox prompts the user;
 * Chromium grants based on site-engagement score), and a denied origin's storage (OPFS project media,
 * IndexedDB, Cache Storage) is evictable under disk pressure with no warning to the app or the user.
 * This is the only path in the product that can silently delete someone's project.
 *
 * Reads `navigator.storage.persisted()` at boot too: an origin already persisted from a previous visit
 * has nothing to ask for, and reporting only the `persist()` outcome would misreport that case as
 * "denied" when it is actually "already granted, this call is a no-op restating it".
 *
 * A denied first ask is retried EXACTLY ONCE, on the user's first real gesture (pointerdown/keydown) —
 * boot-time engagement is zero by definition, and browsers commonly grant on a later ask once the site
 * has actually been used. Reading: `window.__rfStoragePersistence`.
 *
 * Deliberately NOT a user-facing warning here — this repo already has two connectivity-style surfaces
 * (offline banner, waking-API banner) and a third invented without the founder's sign-off on where it
 * lives and what it says would be scope creep, not a fix.
 */

interface StoragePersistenceStatus {
  supported: boolean;
  persistedAtBoot: boolean | null;
  requestedAtBoot: boolean | null;
  retried: boolean;
  persistedAfterRetry: boolean | null;
}

function getStatus(): StoragePersistenceStatus {
  const w = window as unknown as { __rfStoragePersistence?: StoragePersistenceStatus };
  return (w.__rfStoragePersistence ??= {
    supported: false,
    persistedAtBoot: null,
    requestedAtBoot: null,
    retried: false,
    persistedAfterRetry: null,
  });
}

export function installStoragePersistence(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  const status = getStatus();
  const storage = navigator.storage;
  if (!storage?.persist) return;
  status.supported = true;

  void (async () => {
    status.persistedAtBoot = (await storage.persisted?.().catch(() => null)) ?? null;
    if (status.persistedAtBoot) {
      // Already persisted from a previous visit — nothing to ask for, and calling persist() again
      // would just restate the same true, so skip straight to done rather than log a redundant ask.
      status.requestedAtBoot = true;
      return;
    }

    status.requestedAtBoot = await storage.persist().catch(() => false);
    if (status.requestedAtBoot) return;

    // Denied at boot (zero engagement is the worst possible time to ask). Retry once on the user's
    // first real gesture — the same signal browsers themselves use to decide whether to grant it.
    const retry = () => {
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
      if (status.retried) return;
      status.retried = true;
      void storage
        .persist()
        .catch(() => false)
        .then((granted) => {
          status.persistedAfterRetry = granted;
        });
    };
    window.addEventListener("pointerdown", retry, { once: true });
    window.addEventListener("keydown", retry, { once: true });
  })();
}
