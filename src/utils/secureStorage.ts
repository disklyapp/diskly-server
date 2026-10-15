import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../config/b2.js';

/**
 * Generates an authenticated pre-signed URL for Backblaze B2 (Private Bucket).
 * Valid for 6 hours (21,600 seconds).
 * Fallback to original URL if signing fails or credentials are not configured.
 */
export async function getSecureSignedUrl(
  rawUrl: string | null | undefined,
  fallbackKey: string,
  isAttachment: boolean = false,
  filename?: string
): Promise<string> {
  if (!rawUrl || !process.env.B2_ACCESS_KEY_ID || !process.env.B2_SECRET_ACCESS_KEY) {
    return rawUrl || '';
  }

  const bucket = process.env.B2_BUCKET_NAME || 'diskly';
  const isB2Url =
    rawUrl.includes(bucket) ||
    rawUrl.includes('backblazeb2.com') ||
    rawUrl.includes('diskly.in');

  if (!isB2Url && rawUrl.startsWith('http')) {
    return rawUrl;
  }

  try {
    let objectKey = fallbackKey;
    try {
      const parsed = new URL(rawUrl);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const bucketIndex = parts.indexOf(bucket);
      if (bucketIndex !== -1 && bucketIndex + 1 < parts.length) {
        objectKey = parts.slice(bucketIndex + 1).join('/');
      } else if (parts.length > 0) {
        objectKey = parts.filter(p => p !== 'file').join('/');
      }
    } catch {
      objectKey = fallbackKey;
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ...(isAttachment && filename
        ? {
            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename.slice(0, 50))}.mp4"`
          }
        : {})
    });

    // 6 hours = 21,600 seconds
    return await getSignedUrl(s3, command, { expiresIn: 21600 });
  } catch (err) {
    console.warn(`[SecureSignedUrl] Failed to sign URL for ${fallbackKey}:`, err);
    return rawUrl;
  }
}

/**
 * Attaches signed streamUrl and thumbnailUrl to a video object
 */
export async function attachSecureUrlsToVideo<T extends { streamUrl?: string | null; thumbnailUrl?: string | null; downloadKey?: string | null; title?: string | null }>(video: T): Promise<T> {
  if (!video) return video;
  const key = video.downloadKey || 'video';
  const [signedStreamUrl, signedThumbnailUrl] = await Promise.all([
    getSecureSignedUrl(video.streamUrl, `videos/${key}.mp4`),
    getSecureSignedUrl(video.thumbnailUrl, `thumbnails/${key}.jpg`)
  ]);

  return {
    ...video,
    streamUrl: signedStreamUrl,
    thumbnailUrl: signedThumbnailUrl
  };
}

/**
 * Attaches signed streamUrl and thumbnailUrl to an array of video objects in parallel
 */
export async function attachSecureUrlsToVideos<T extends { streamUrl?: string | null; thumbnailUrl?: string | null; downloadKey?: string | null; title?: string | null }>(videos: T[]): Promise<T[]> {
  if (!Array.isArray(videos)) return videos;
  return Promise.all(videos.map(v => attachSecureUrlsToVideo(v)));
}
