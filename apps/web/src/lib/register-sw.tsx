'use client';
import { useEffect } from 'react';

/** Регистрирует служебный скрипт (только запасная страница «нет связи»; данные не кэшируются). Ошибки регистрации не мешают работе. */
export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);
  return null;
}
