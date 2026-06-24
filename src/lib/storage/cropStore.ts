// Crops are large base64 data URLs that don't fit localStorage's ~5MB budget.
// IndexedDB has no practical cap, so crops persist across reloads and the review
// pane can show the exact image even after the page is closed and reopened.

const DB_NAME = 'cheque-scanner';
const STORE = 'crops';
const VERSION = 1;
const browser = typeof window !== 'undefined' && 'indexedDB' in window;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!browser) return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function putCrop(id: string, dataUrl: string): Promise<void> {
  if (!browser || !dataUrl) return;
  try {
    const s = await store('readwrite');
    await wrap(s.put(dataUrl, id));
  } catch {
    /* best-effort cache; ignore quota/transaction failures */
  }
}

export async function getCrop(id: string): Promise<string | null> {
  if (!browser) return null;
  try {
    const s = await store('readonly');
    return (await wrap<string>(s.get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function deleteCrop(id: string): Promise<void> {
  if (!browser) return;
  try {
    const s = await store('readwrite');
    await wrap(s.delete(id));
  } catch {
    /* ignore */
  }
}

export async function clearCrops(): Promise<void> {
  if (!browser) return;
  try {
    const s = await store('readwrite');
    await wrap(s.clear());
  } catch {
    /* ignore */
  }
}
