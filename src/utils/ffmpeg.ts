import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
}

export interface VideoFormatInfo {
  ext: string;
  mimeType: string;
  needsTranscoding: boolean;
}

/**
 * Normalizes video format and determines MIME type & transcoding requirement.
 * Supported formats: MKV, AVI, MOV, WEBM, MP4.
 */
export const normalizeVideoFormat = (rawMime?: string, originalFileName?: string): VideoFormatInfo => {
  const mime = (rawMime || '').toLowerCase();
  const fileName = (originalFileName || '').toLowerCase();

  // MKV (Matroska)
  if (mime.includes('matroska') || fileName.endsWith('.mkv')) {
    return { ext: 'mkv', mimeType: 'video/x-matroska', needsTranscoding: false };
  }

  // AVI (Audio Video Interleave) - not streamable on mobile/web natively, requires transcoding
  if (mime.includes('msvideo') || mime.includes('avi') || fileName.endsWith('.avi')) {
    return { ext: 'avi', mimeType: 'video/x-msvideo', needsTranscoding: true };
  }

  // MOV (QuickTime)
  if (mime.includes('quicktime') || fileName.endsWith('.mov')) {
    return { ext: 'mov', mimeType: 'video/quicktime', needsTranscoding: false };
  }

  // WEBM
  if (mime.includes('webm') || fileName.endsWith('.webm')) {
    return { ext: 'webm', mimeType: 'video/webm', needsTranscoding: false };
  }

  // MP4 / M4V
  if (mime.includes('mp4') || fileName.endsWith('.mp4') || fileName.endsWith('.m4v')) {
    return { ext: 'mp4', mimeType: 'video/mp4', needsTranscoding: false };
  }

  // Fallback by extension
  const match = fileName.match(/\.([a-z0-9]+)$/);
  if (match) {
    const ext = match[1];
    return {
      ext,
      mimeType: rawMime || `video/${ext}`,
      needsTranscoding: ext === 'avi' || ext === 'flv' || ext === 'wmv',
    };
  }

  return { ext: 'mp4', mimeType: 'video/mp4', needsTranscoding: false };
};

/**
 * Transcodes video (e.g. AVI, incompatible codecs) to fast-streaming MP4 (H.264 + AAC + faststart).
 * If transcoding fails, rejects so calling code can decide on fallback.
 */
export const transcodeToStreamableMp4 = async (
  inputPath: string,
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<void> => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart', // Crucial for instant progressive streaming
      ])
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent && onProgress) {
          onProgress(Math.round(progress.percent));
        }
      })
      .on('end', () => {
        console.log(`[FFmpeg] Transcoding complete: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`[FFmpeg] Transcoding failed:`, err);
        reject(err);
      })
      .run();
  });
};

/**
 * Generates video thumbnail at 1s timestamp.
 */
export const extractThumbnail = async (
  inputPath: string,
  folder: string,
  filename: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: ['00:00:01.000'],
        filename,
        folder,
        size: '320x240',
      })
      .on('end', () => resolve())
      .on('error', (err) => reject(err));
  });
};

export default ffmpeg;
