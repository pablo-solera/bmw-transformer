/** In-memory stand-in for src/storage.ts, used by flow tests through `mock.module`. */
export function createMemoryStorage(prefix = "TEST") {
  const objects = new Map<string, Uint8Array>();
  const clean = (part: string) => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const objectKey = (...parts: string[]) => [prefix, ...parts].map(clean).filter(Boolean).join("/");
  const putBytes = async (key: string, body: Uint8Array) => { objects.set(key, new Uint8Array(body)); };
  const getBytes = async (key: string) => {
    const value = objects.get(key);
    if (!value) throw new Error(`NoSuchKey: ${key}`);
    return value;
  };
  return {
    objects,
    seed(items: Array<{ parts: string[]; body: Uint8Array }>) {
      for (const item of items) objects.set(objectKey(...item.parts), item.body);
    },
    module: {
      objectKey,
      putBytes,
      getBytes,
      putJson: async (key: string, value: unknown) => putBytes(key, new TextEncoder().encode(JSON.stringify(value, null, 2))),
      getJson: async <T>(key: string) => JSON.parse(new TextDecoder().decode(await getBytes(key))) as T,
      listKeys: async (keyPrefix: string) => [...objects.keys()].filter(key => key.startsWith(keyPrefix)).sort(),
      deleteObject: async (key: string) => { objects.delete(key); },
      signedDownload: async (key: string) => `memory://${key}`,
      ensureBucket: async () => {},
      checkBucket: async () => {},
    },
  };
}
