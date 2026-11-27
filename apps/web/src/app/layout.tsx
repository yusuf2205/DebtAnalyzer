import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { RegisterSW } from '@/lib/register-sw';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Procurement Finance', description: 'Контроль договоров, оплат и задолженности перед поставщиками',
  icons: { icon: '/icons/icon.svg', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Procurement', statusBarStyle: 'default' },
};
export const viewport: Viewport = { themeColor: '#4f7a55' };

/** Динамический рендеринг: Next подставляет CSP-nonce в свои скрипты только для динамических страниц (приложение закрыто входом, статика не нужна). */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="ru" suppressHydrationWarning>
      {/* Манифест запрашивается с cookie (crossOrigin=use-credentials): домен закрыт Cloudflare Access */}
      <head><link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" /></head>
      <body><SessionProvider>{children}</SessionProvider><RegisterSW /></body>
    </html>
  );
}
