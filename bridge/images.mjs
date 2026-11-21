export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function validImage(image) {
  if (typeof image?.base64 !== 'string' || !image.base64 || image.base64.length > MAX_IMAGE_BASE64 ||
      image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) return false;
  const bytes = Buffer.from(image.base64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.base64) return false;
  switch (image.mimeType) {
    case 'image/jpeg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/gif': return /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6));
    case 'image/webp': return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    default: return false;
  }
}
