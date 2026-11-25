/**
 * YouTube links and metadata for TALKS - no API key.
 *
 * - parseYouTubeVideoId: the 11-character video id from a youtu.be, watch,
 *   shorts, embed or live link (tracking parameters such as ?si= ignored);
 *   null for anything else.
 * - canonicalYouTubeUrl: the one URL stored and shared for a video.
 * - fetchYouTubeOEmbed: YouTube's public oEmbed endpoint (title, channel,
 *   thumbnail). It has no description, duration, upload date or views, and
 *   nothing here guesses them. No HTML is scraped.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const PATH_FORMS = ['shorts', 'embed', 'live', 'v'];

export const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';
const OEMBED_TIMEOUT_MS = 8000;

/** The video id of a YouTube link, or null when [input] is not one. */
export const parseYouTubeVideoId = (input) => {
  if (typeof input !== 'string') return null;
  let url;
  try {
    const raw = input.trim();
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (SHORT_HOSTS.has(host)) {
    id = parts[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (PATH_FORMS.includes(parts[0])) id = parts[1] ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
};

export const canonicalYouTubeUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/** For tests: replaces the HTTP call (same signature as fetch). */
let fetchImpl = (...args) => fetch(...args);
export const setOEmbedFetch = (impl) => {
  fetchImpl = impl ?? ((...args) => fetch(...args));
};

/**
 * The oEmbed metadata of [videoId]:
 *   { status: 'complete', metadata: { title, channelName, channelUrl, thumbnailUrl, thumbnailWidth, thumbnailHeight } }
 *   { status: 'unavailable', error }  - YouTube says private, removed or not embeddable (401 / 403 / 404)
 *   { status: 'failed', error }       - network, timeout or an unexpected answer (try again later)
 * Never throws.
 */
export const fetchYouTubeOEmbed = async (videoId) => {
  const target = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(canonicalYouTubeUrl(videoId))}&format=json`;
  try {
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if ([401, 403, 404].includes(res.status)) {
      return { status: 'unavailable', error: `YouTube reports this video as unavailable (HTTP ${res.status})` };
    }
    if (!res.ok) return { status: 'failed', error: `YouTube oEmbed answered HTTP ${res.status}` };
    const body = await res.json();
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const num = (v) => (Number.isFinite(v) ? v : null);
    const title = str(body?.title);
    if (!title) return { status: 'failed', error: 'YouTube oEmbed returned no title' };
    return {
      status: 'complete',
      metadata: {
        title,
        channelName: str(body.author_name),
        channelUrl: str(body.author_url),
        thumbnailUrl: str(body.thumbnail_url),
        thumbnailWidth: num(body.thumbnail_width),
        thumbnailHeight: num(body.thumbnail_height),
      },
    };
  } catch (error) {
    return { status: 'failed', error: `Could not reach YouTube oEmbed: ${error.message}` };
  }
};
