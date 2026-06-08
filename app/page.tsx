'use client';

import dynamic from 'next/dynamic';

const AIPlayground = dynamic(() => import('@/components/AIPlayground'), { ssr: false });

export default function Home() {
  return <AIPlayground />;
}