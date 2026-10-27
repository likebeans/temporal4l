import { fileURLToPath } from 'node:url';
import { runDocumentReviewCli } from '../support/runner';

await runDocumentReviewCli('problem', fileURLToPath(new URL('./workflow.ts', import.meta.url)));
