import { describe, expect, it } from 'vitest';
import { normalizeDirectMediaUrl, normalizeExtractedMediaFields } from './media.js';

describe('media helpers', () => {
  it('keeps direct-play m3u8 urls and rejects embed/player urls', () => {
    expect(
      normalizeDirectMediaUrl('https://cdn.example.com/video/master.m3u8?token=abc123', 'video'),
    ).toBe('https://cdn.example.com/video/master.m3u8?token=abc123');
    expect(
      normalizeDirectMediaUrl('https://player.vimeo.com/video/123456789', 'video'),
    ).toBeNull();
  });

  it('resolves relative image and video urls against the page url', () => {
    expect(
      normalizeExtractedMediaFields(
        {
          main_image_url: '/assets/cover.jpg?size=large',
          main_video_url: '/media/master.m3u8?token=abc123',
        },
        'https://www.example.com/projects/demo',
      ),
    ).toEqual({
      primary_image_url: 'https://www.example.com/assets/cover.jpg?size=large',
      primary_video_url: 'https://www.example.com/media/master.m3u8?token=abc123',
    });
  });
});
