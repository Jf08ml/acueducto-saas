'use client';

import { ReceiptsView } from '@/components/receipts-view';

const byPeriod = (q: URLSearchParams) => (/^\d{4}-\d{2}$/.test(q.get('p') ?? '') ? `/billing/periods/${q.get('p')}/receipts` : null);

export default function RecibosPage() {
  return <ReceiptsView source={byPeriod} />;
}
