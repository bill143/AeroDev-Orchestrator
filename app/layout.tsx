import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Arena — Multi-Model AI Platform',
  description: 'Chat with, compare, and orchestrate AI models.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
