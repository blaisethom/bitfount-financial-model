// Xero source adapter — stub. Will fetch invoices / contacts / etc. from
// Xero's API once auth + sync endpoint are added on the server side.
//
// Planned config shape:
//   { entity: 'invoices' | 'contacts' | 'bank_transactions'; dateRange?: { from: string; to: string } }
//
// Needs: server endpoint /api/xero/sync that holds the Xero OAuth token
// (Xero uses OAuth 2.0 + refresh tokens, not a simple API key like HubSpot).

import type { Table, TableSchema } from '../types';
import type { SourceAdapter } from './index';

export interface XeroSourceConfig {
  entity: 'invoices' | 'contacts' | 'bank_transactions';
  dateRange?: { from: string; to: string };
}

export const xeroAdapter: SourceAdapter<XeroSourceConfig> = {
  id: 'xero',
  async fetch(_config: XeroSourceConfig, _schema: TableSchema): Promise<Table> {
    throw new Error(
      'xeroAdapter: not implemented. Add /api/xero/sync server endpoint and ' +
      'replace this stub with normalization logic similar to hubspotAdapter.',
    );
  },
};
