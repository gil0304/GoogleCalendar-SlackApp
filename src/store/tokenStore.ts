import fs from 'node:fs/promises';
import path from 'node:path';

type TokenStore = Record<string, { refreshToken: string; email?: string }>;

const tokenStorePath = path.join(process.cwd(), 'data', 'tokens.json');

async function readTokenStore(): Promise<TokenStore> {
  try {
    const raw = await fs.readFile(tokenStorePath, 'utf8');
    return JSON.parse(raw) as TokenStore;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function writeTokenStore(store: TokenStore) {
  await fs.mkdir(path.dirname(tokenStorePath), { recursive: true });
  await fs.writeFile(tokenStorePath, JSON.stringify(store, null, 2), 'utf8');
}

export async function getUserToken(userId: string): Promise<TokenStore[string] | null> {
  const store = await readTokenStore();
  return store[userId] ?? null;
}

export async function setUserToken(userId: string, refreshToken: string, email?: string) {
  const store = await readTokenStore();
  store[userId] = { refreshToken, email };
  await writeTokenStore(store);
}

export async function updateUserEmail(userId: string, email: string) {
  const store = await readTokenStore();
  const current = store[userId];
  if (!current) return;
  store[userId] = { ...current, email };
  await writeTokenStore(store);
}

export async function removeUserToken(userId: string) {
  const store = await readTokenStore();
  if (!store[userId]) return;
  delete store[userId];
  await writeTokenStore(store);
}

export async function listUserTokens(): Promise<Array<{ userId: string; email?: string }>> {
  const store = await readTokenStore();
  return Object.entries(store).map(([userId, value]) => ({
    userId,
    email: value.email
  }));
}
