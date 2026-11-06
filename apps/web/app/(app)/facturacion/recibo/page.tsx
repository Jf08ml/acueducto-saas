'use client';

import { ReceiptsView } from '@/components/receipts-view';

const byId = (q: URLSearchParams) => (q.get('id') ? `/invoices/${q.get('id')}` : null);

export default function ReciboPage() {
  return <ReceiptsView source={byId} />;
}
