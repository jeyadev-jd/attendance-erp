export async function putReport(
  bucket: R2Bucket,
  key: string,
  data: string | Uint8Array,
  contentType: string
): Promise<void> {
  await bucket.put(key, data, { httpMetadata: { contentType } });
}

export async function getReport(bucket: R2Bucket, key: string) {
  return bucket.get(key);
}

/** Namespaces report keys per org so one tenant can never read another's exports. */
export function reportKey(organizationId: string, filename: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `reports/${organizationId}/${timestamp}-${filename}`;
}
