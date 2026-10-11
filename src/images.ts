import { ChatImage } from './bridge';

export const imageLimit = 10 * 1024 * 1024;
// Validate bytes, not extensions or webview-supplied paths. ImageIO validates decoding too.
export function imageFromBytes(name: string, bytes: Uint8Array): ChatImage {
  const data = Buffer.from(bytes);
  if (!data.length || data.length > imageLimit) throw new Error('Invalid image size');
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (!png && !jpeg) throw new Error('Unsupported image');
  return { name, data: data.toString('base64'), mime: png ? 'image/png' : 'image/jpeg' };
}
