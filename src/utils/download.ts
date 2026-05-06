// Browser-only helper. Triggers a "save as" download for arbitrary text
// (currently used by the Backup view to save backup JSON to the user's
// disk). Pure data-layer code must never call this — exporter and
// auto-backup return strings; the view chooses what to do with them.

export interface DownloadOptions {
  readonly mimeType?: string;
}

export function downloadTextFile(
  filename: string,
  content: string,
  options: DownloadOptions = {},
): void {
  const mimeType = options.mimeType ?? 'application/json';
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Allow the browser to start the download before revoking. The 1s
  // delay is generous; the URL is just an opaque blob handle.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1_000);
}
