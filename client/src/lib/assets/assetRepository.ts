export interface AssetRecord { id: string; blob: Blob; mimeType: string; createdAt: string }

/** Native IndexedDB only; callers handle rejected operations and missing records explicitly. */
export function createAssetRepository(databaseName = 'frameflow-assets', factory: () => IDBFactory = () => indexedDB) {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory().open(databaseName, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('assets', { keyPath: 'id' }); };
      request.onerror = () => reject(request.error ?? new Error('Could not open image storage.'));
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new Error('Image storage is blocked. Close other FrameFlow tabs and retry.')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }
  async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('assets', mode);
        const request = operation(tx.objectStore('assets'));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Image storage transaction failed.'));
        tx.onerror = () => reject(tx.error ?? new Error('Image storage transaction failed.'));
      });
    } finally { db.close(); }
  }
  return {
    async putAsset(id: string, blob: Blob) {
      if (!id || /^(blob:|data:)/i.test(id) || !blob.type.startsWith('image/')) throw new Error('An image Blob and stable asset ID are required.');
      const record: AssetRecord = { id, blob, mimeType: blob.type, createdAt: new Date().toISOString() };
      await transaction('readwrite', (store) => store.put(record));
    },
    async getAsset(id: string): Promise<AssetRecord | null> {
      return (await transaction<AssetRecord | undefined>('readonly', (store) => store.get(id))) ?? null;
    },
    async hasAsset(id: string) { return (await transaction('readonly', (store) => store.count(id))) > 0; },
    async deleteAsset(id: string) { await transaction('readwrite', (store) => store.delete(id)); },
  };
}
