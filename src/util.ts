export function isMemberOfEnum<T extends object, U extends keyof T>(
  enumType: T,
  value: unknown,
): value is T[U] {
  return Object.values(enumType).includes(value as T[U]);
}
