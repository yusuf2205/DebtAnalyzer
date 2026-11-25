import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = { title: 'Procurement Finance', description: 'Контроль договоров, оплат и задолженности перед поставщиками' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body><SessionProvider>{children}</SessionProvider></body>
    </html>
  );
}
