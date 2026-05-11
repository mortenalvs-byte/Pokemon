// Memory pointer pattern: store large tool outputs (>100KB) as blobs and
// reference them by SHA path in the review packet. Mitigates the
// "context bloat over days" failure mode from the 30-day-agent postmortem.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_THRESHOLD = parseInt(process.env.AI_SUPERVISOR_MEMORY_POINTER_THRESHOLD ?? '102400', 10);
const BLOBS_DIR_DEFAULT = path.join(process.cwd(), '.local', 'ai-supervisor', 'blobs');

/**
 * If content size exceeds the threshold, store it as a blob and return a pointer.
 * Otherwise return the content unchanged.
 *
 * @param {string} content
 * @param {object} [opts]
 * @param {string} [opts.summary] — short summary for the pointer
 * @param {string} [opts.blobsDir]
 * @param {number} [opts.threshold]
 * @returns {Promise<string | {ref: string, summary: string, size_bytes: number, sample: string, sha256: string}>}
 */
export async function maybeStoreAsBlob(content, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  if (typeof content !== 'string') content = String(content);
  if (content.length <= threshold) return content;

  const blobsDir = opts.blobsDir ?? BLOBS_DIR_DEFAULT;
  await mkdir(blobsDir, { recursive: true });

  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const blobPath = path.join(blobsDir, `blob-${sha.slice(0, 16)}.txt`);

  // Idempotent write: only write if not already present
  try {
    await readFile(blobPath, 'utf8');
  } catch {
    await writeFile(blobPath, content, 'utf8');
  }

  const sample = content.slice(0, 200).replace(/\n/g, ' ');
  return {
    ref: path.basename(blobPath),
    summary: opts.summary ?? `Tool output, ${content.length} bytes, ${(content.match(/\n/g) ?? []).length + 1} lines`,
    size_bytes: content.length,
    sample,
    sha256: sha,
  };
}

/**
 * Load a blob by ref (filename without dir).
 * @param {string} ref
 * @param {string} [blobsDir]
 */
export async function loadBlob(ref, blobsDir = BLOBS_DIR_DEFAULT) {
  return readFile(path.join(blobsDir, ref), 'utf8');
}
