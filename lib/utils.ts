import fs from 'node:fs';

export async function ensureDirExists(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.promises.access(path);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err; // Rethrow if it's not a "not found" error
  }
}

export function base64UrlDecode(encodedString: string): string {
  if (!encodedString) return "";
  // Replace URL-safe characters and add padding if needed
  let base64 = encodedString.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf-8");
}

export async function asyncFind<T>(array: T[], predicate: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of array) {
    if (await predicate(item)) {
      return item;
    }
  }
}
