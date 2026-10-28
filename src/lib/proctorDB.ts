'use client';

export interface ViolationRecord {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  message: string;
  confidence: number;
  integrityScoreAtEvent: number;
}

const DB_NAME = 'ProctorDB';
const DB_VERSION = 1;
const STORE_NAME = 'violations';

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

export async function saveViolation(record: ViolationRecord): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ProctorDB] saveViolation failed:', err);
  }
}

export async function getSessionViolations(sessionId: string): Promise<ViolationRecord[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('sessionId');
      const req = index.getAll(sessionId);
      req.onsuccess = () => resolve((req.result as ViolationRecord[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ProctorDB] getSessionViolations failed:', err);
    return [];
  }
}

export async function clearSession(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    const violations = await getSessionViolations(sessionId);
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      violations.forEach((v) => store.delete(v.id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve(); // best-effort
    });
  } catch (err) {
    console.warn('[ProctorDB] clearSession failed:', err);
  }
}
