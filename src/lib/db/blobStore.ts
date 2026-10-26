import { BlobNotFoundError, get, head, put } from "@vercel/blob";

/** Private Blob object holding the live database snapshot (gzipped JSON rows). */
export const LIVE_BLOB_PATH = "inside-scoop-trends/live-db.json.gz";

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function loadLiveBlob(): Promise<{ buf: Buffer; etag: string } | null> {
  const res = await get(LIVE_BLOB_PATH, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) return null;
  return { buf: await streamToBuffer(res.stream), etag: res.blob.etag };
}

export async function headLiveEtag(): Promise<string | null> {
  try {
    return (await head(LIVE_BLOB_PATH)).etag;
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

/** Writes the snapshot; when `etag` is given the write only succeeds if nobody saved in between. */
export async function saveLiveBlob(buf: Buffer, etag: string | null): Promise<string> {
  const res = await put(LIVE_BLOB_PATH, buf, {
    access: "private",
    allowOverwrite: true,
    contentType: "application/gzip",
    cacheControlMaxAge: 60,
    ...(etag ? { ifMatch: etag } : {}),
  });
  return res.etag;
}
