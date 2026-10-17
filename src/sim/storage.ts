/** Best-effort on-device storage for the browser's most recent synthetic ledgers. */
const DATABASE = 'ghostwheel-local-evidence';
const STORE = 'archives';
const KEY = 'recent-v1';

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(DATABASE, 1);
    pending.onupgradeneeded = () => {
      if (!pending.result.objectStoreNames.contains(STORE)) pending.result.createObjectStore(STORE);
    };
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error || new Error('IndexedDB unavailable'));
  });
}

export async function loadRunArchive(): Promise<unknown> {
  const db = await openDatabase();
  if (!db) return [];
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error || new Error('Archive read failed'));
    });
  } finally {
    db.close();
  }
}

export async function saveRunArchive(archive: unknown[]): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(archive, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Archive write failed'));
      tx.onabort = () => reject(tx.error || new Error('Archive write aborted'));
    });
  } finally {
    db.close();
  }
}
