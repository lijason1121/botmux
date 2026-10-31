import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface ReportResultSource {
  larkAppId: string;
  sessionId: string;
  chatId?: string;
  dispatchRoot: string;
  turnId: string;
  dispatchAttempt?: number;
  report?: { delivery: string; publishTo: string; status?: string; progress?: number; remaining?: string; milestone?: string };
}
export interface ReportResultReceipt { id: string; contentPath: string; receiptPath: string; receivedAt: string }

/** Call only after live source/turn authorization. Saving the result grants no
 * delivery authority: a later resend must pass the current normal send checks. */
export function archiveReportResult(dataDir: string, source: ReportResultSource, content: string): ReportResultReceipt {
  const contentSha256 = createHash('sha256').update(content).digest('hex');
  const id = createHash('sha256').update(JSON.stringify([source, contentSha256])).digest('hex');
  const dir = join(dataDir, 'report-results', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const contentPath = join(dir, 'content.md'), receiptPath = join(dir, 'receipt.json');
  let receivedAt = new Date().toISOString();
  withFileLockSync(receiptPath, () => {
    if (existsSync(receiptPath)) {
      const saved = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (saved.id !== id || saved.contentSha256 !== contentSha256
        || typeof saved.receivedAt !== 'string'
        || createHash('sha256').update(readFileSync(contentPath)).digest('hex') !== contentSha256) {
        throw new Error('report_result_integrity_failed');
      }
      receivedAt = saved.receivedAt;
      return;
    }
    atomicWriteFileSync(contentPath, content, { mode: 0o600, durable: true, followTargetSymlink: false });
    atomicWriteFileSync(receiptPath, JSON.stringify({ version: 1, id, source, contentSha256,
      receivedAt, delivery: { publication: 'not_attempted', relay: 'not_attempted' } }),
    { mode: 0o600, durable: true, followTargetSymlink: false });
  });
  return { id, contentPath, receiptPath, receivedAt };
}

/** Transport delivery is independent of the saved review/content. Unknown
 * outcomes stay unknown; receipt presence never authorizes automatic replay. */
export function recordReportResultDelivery(receipt: ReportResultReceipt, status: number, body: Record<string, unknown>): void {
  withFileLockSync(receipt.receiptPath, () => {
    const saved = JSON.parse(readFileSync(receipt.receiptPath, 'utf8'));
    if (saved.id !== receipt.id) throw new Error('report_result_integrity_failed');
    const fallback = body.relayFallback as { published?: boolean } | undefined;
    const publishedMessageId = typeof body.publishedMessageId === 'string' ? body.publishedMessageId : undefined;
    const triggerId = typeof body.triggerId === 'string' ? body.triggerId : undefined;
    const accepted = status >= 200 && status < 300 && body.ok === true;
    const delivery = {
      publication: publishedMessageId || saved.delivery?.publication === 'published' ? 'published' : 'unconfirmed',
      relay: saved.delivery?.relay === 'delivered' ? 'delivered'
        : fallback || body.delivery === 'publish' ? 'not_delivered' : accepted ? 'delivered' : 'unconfirmed',
      ...(saved.delivery?.publishedMessageId ? { publishedMessageId: saved.delivery.publishedMessageId } : {}),
      ...(saved.delivery?.triggerId ? { triggerId: saved.delivery.triggerId } : {}),
      ...(publishedMessageId ? { publishedMessageId } : {}), ...(triggerId ? { triggerId } : {}),
      status, updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(receipt.receiptPath, JSON.stringify({ ...saved, delivery }),
      { mode: 0o600, durable: true, followTargetSymlink: false });
  });
}
