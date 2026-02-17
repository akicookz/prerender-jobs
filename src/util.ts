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
