import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = { title: 'Procurement Finance', description: 'Контроль договоров, оплат и задолженности перед поставщиками' };

/** Динамический рендеринг: Next подставляет CSP-nonce в свои скрипты только для динамических страниц (приложение закрыто входом, статика не нужна). */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="ru" suppressHydrationWarning>
      <body><SessionProvider>{children}</SessionProvider></body>
    </html>
  );
}
