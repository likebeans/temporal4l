import api from '../server/index.ts?raw';
import worker from '../server/worker.ts?raw';
import workflow from '../server/workflows.ts?raw';
import activities from '../server/activities.ts?raw';
import ledger from '../server/payment-ledger.ts?raw';
import recovery from './recovery.ts?raw';
import { collectSourceExcerpts } from './source-excerpts';

export const learningSources = collectSourceExcerpts({
  'server/index.ts': api,
  'server/worker.ts': worker,
  'server/workflows.ts': workflow,
  'server/activities.ts': activities,
  'server/payment-ledger.ts': ledger,
  'src/recovery.ts': recovery,
});
