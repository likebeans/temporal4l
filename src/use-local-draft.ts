import { useEffect, useState } from 'react';

// 浏览器草稿只是当前设备上的便利副本；不可用时仍可编辑和导出。
export function useLocalDraft<T>(key: string, initial: T, validate: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const stored: unknown = JSON.parse(raw);
        if (validate(stored)) return stored;
      }
    } catch { /* 清空、损坏或被禁用的存储不阻止学习。 */ }
    return initial;
  });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }, [key, value]);
  return [value, setValue, saved] as const;
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}
