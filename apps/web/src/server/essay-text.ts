// PLACEHOLDER (essays reader, slice 1). Essay text lives in the private S3 bucket under text_s3_key,
// and the web Lambda cannot read it yet: the IAM grant and the bucket read are the next slice.
// Until then this returns null for every essay, and the reader shows "Text storage connection pending".
// Do not add S3 access here without that slice's infra change.
export async function loadEssayText(_textS3Key: string | null): Promise<string | null> {
  return null;
}
