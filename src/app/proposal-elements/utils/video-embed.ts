/** Detect provider URLs and derive iframe-friendly embed origins. No network I/O. */

export type EmbedKind = 'youtube' | 'vimeo' | 'twitch' | 'fileVideo' | 'unknown';

export interface ParsedVideoEmbed {
  kind: Exclude<EmbedKind, 'unknown'>;
  embedSrc: string;
}

export type ParseVideoEmbedOptions = {
  /** Required by Twitch embed iframes (host that serves the page). */
  embedParent?: string;
};

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

function extractTwitchEmbed(raw: string, parent: string): ParsedVideoEmbed | null {
  try {
    const u = new URL(raw.trim());
    const p = encodeURIComponent(parent || 'localhost');
    const host = u.hostname.toLowerCase();

    if (host === 'clips.twitch.tv') {
      const clip = u.pathname.replace(/^\//, '').split(/[/?#]/)[0];
      if (clip) {
        return {
          kind: 'twitch',
          embedSrc: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clip)}&parent=${p}`
        };
      }
      return null;
    }

    if (!host.includes('twitch.tv')) return null;
    const parts = u.pathname.split('/').filter(Boolean);

    if (parts[0] === 'videos' && parts[1] && /^\d+$/.test(parts[1])) {
      return {
        kind: 'twitch',
        embedSrc: `https://player.twitch.tv/?video=v${encodeURIComponent(parts[1])}&parent=${p}&muted=false`
      };
    }
    if (parts[0] === 'clip' && parts[1]) {
      return {
        kind: 'twitch',
        embedSrc: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(parts[1])}&parent=${p}`
      };
    }
    if (parts.length === 1 && parts[0] && !['videos', 'clip', 'clips', 'embed'].includes(parts[0])) {
      return {
        kind: 'twitch',
        embedSrc: `https://player.twitch.tv/?channel=${encodeURIComponent(parts[0])}&parent=${p}&muted=false`
      };
    }
  } catch {
    /* not URL */
  }
  return null;
}

export function parseVideoEmbedInput(url: string, opts?: ParseVideoEmbedOptions): ParsedVideoEmbed | null {
  const t = url.trim();
  if (!t) return null;

  const parent = (opts?.embedParent ?? 'localhost').trim() || 'localhost';

  const yt = extractYoutubeId(t);
  if (yt) {
    return {
      kind: 'youtube',
      embedSrc: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?rel=0`
    };
  }

  const vm = extractVimeoId(t);
  if (vm) {
    return {
      kind: 'vimeo',
      embedSrc: `https://player.vimeo.com/video/${encodeURIComponent(vm)}`
    };
  }

  const tw = extractTwitchEmbed(t, parent);
  if (tw) return tw;

  const lower = t.toLowerCase();
  const looksLikeFileVideo =
    /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|m3u8|mpd)(\?|#|$)/i.test(lower) ||
    lower.includes('video/mp4') ||
    lower.includes('video/webm') ||
    lower.includes('application/vnd.apple.mpegurl') ||
    lower.includes('application/dash+xml');
  if (looksLikeFileVideo || t.startsWith('blob:')) {
    return { kind: 'fileVideo', embedSrc: t };
  }

  // Direct HTTPS URLs (many stream/CDN endpoints have no file extension)
  if (/^https?:\/\//i.test(t)) {
    return { kind: 'fileVideo', embedSrc: t };
  }

  return null;
}
