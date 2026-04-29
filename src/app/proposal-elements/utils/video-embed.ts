/** Detect provider URLs and derive iframe-friendly embed origins. No network I/O. */

export type EmbedKind = 'youtube' | 'vimeo' | 'fileVideo' | 'unknown';

export interface ParsedVideoEmbed {
  kind: Exclude<EmbedKind, 'unknown'>;
  embedSrc: string;
}

/** YouTube bare video id length is 11; allow common URL shapes. */
function extractYoutubeId(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split(/[/?#]/)[0];
      return id && id.length >= 6 ? id : null;
    }
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const paths = u.pathname.split('/').filter(Boolean);
      const embedIdx = paths.indexOf('embed');
      if (embedIdx >= 0 && paths[embedIdx + 1]) return paths[embedIdx + 1]!;
      const shortIdx = paths.indexOf('shorts');
      if (shortIdx >= 0 && paths[shortIdx + 1]) return paths[shortIdx + 1]!;
    }
  } catch {
    /* not URL */
  }
  return null;
}

function extractVimeoId(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (!u.hostname.includes('vimeo.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const seg = parts[parts.length - 1]!;
    return /^\d+$/.test(seg) ? seg : null;
  } catch {
    return null;
  }
}

export function parseVideoEmbedInput(url: string): ParsedVideoEmbed | null {
  const t = url.trim();
  if (!t) return null;

  const yt = extractYoutubeId(t);
  if (yt) {
    return {
      kind: 'youtube',
      embedSrc: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}`
    };
  }

  const vm = extractVimeoId(t);
  if (vm) {
    return {
      kind: 'vimeo',
      embedSrc: `https://player.vimeo.com/video/${encodeURIComponent(vm)}`
    };
  }

  const lower = t.toLowerCase();
  const looksLikeFileVideo =
    /\.(mp4|webm|ogv|ogg|mov|m4v|mkv)(\?|#|$)/i.test(lower) ||
    lower.includes('video/mp4') ||
    lower.includes('video/webm');
  if (looksLikeFileVideo || t.startsWith('blob:')) {
    return { kind: 'fileVideo', embedSrc: t };
  }

  return null;
}
