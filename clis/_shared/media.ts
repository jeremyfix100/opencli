const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);

const VIDEO_EXTENSIONS = new Set(['.m3u8', '.mp4']);

export type MediaUrlKind = 'image' | 'video';

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeDirectMediaUrl(
  value: unknown,
  kind: MediaUrlKind,
  baseUrl?: string,
): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;

  try {
    const parsed = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const pathname = parsed.pathname.toLowerCase();
    const isDirect =
      kind === 'video'
        ? [...VIDEO_EXTENSIONS].some((ext) => pathname.endsWith(ext))
        : [...IMAGE_EXTENSIONS].some((ext) => pathname.endsWith(ext));
    return isDirect ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function pickDirectMediaUrl(
  values: unknown[],
  kind: MediaUrlKind,
  baseUrl?: string,
): string | null {
  for (const value of values) {
    const normalized = normalizeDirectMediaUrl(value, kind, baseUrl);
    if (normalized) return normalized;
  }
  return null;
}

export function normalizeExtractedMediaFields(
  values: Record<string, unknown>,
  baseUrl?: string,
): {
  primary_image_url: string | null;
  primary_video_url: string | null;
} {
  return {
    primary_image_url: pickDirectMediaUrl(
      [
        values.primary_image_url,
        values.image_url,
        values.main_image_url,
        values.hero_image_url,
        values.imageUrl,
        values.mainImageUrl,
        values.heroImageUrl,
        values.poster_url,
      ],
      'image',
      baseUrl,
    ),
    primary_video_url: pickDirectMediaUrl(
      [
        values.primary_video_url,
        values.video_url,
        values.main_video_url,
        values.hero_video_url,
        values.videoUrl,
        values.mainVideoUrl,
        values.heroVideoUrl,
      ],
      'video',
      baseUrl,
    ),
  };
}
