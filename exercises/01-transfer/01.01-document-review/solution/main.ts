import { fileURLToPath } from 'node:url';
import { runDocumentReviewCli } from '../support/runner';

await runDocumentReviewCli('solution', fileURLToPath(new URL('./workflow.ts', import.meta.url)));
