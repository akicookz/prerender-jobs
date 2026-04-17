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

export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export function escapeMarkdownV2Code(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}
