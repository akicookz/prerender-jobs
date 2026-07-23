export function isMemberOfEnum<T extends object, U extends keyof T>(
  enumType: T,
  value: unknown,
): value is T[U] {
  return Object.values(enumType).includes(value as T[U]);
}

export function extractPathFromUrl(url: string): string {
  const urlObj = new URL(url);
  return urlObj.pathname;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export function escapeMarkdownV2Code(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}
