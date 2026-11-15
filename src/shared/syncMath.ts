import type { PlaybackState, TrackItem } from './types';

export interface ClockSample {
  rttMs: number;
  offsetMs: number;
  sampledAt: number;
}

export type SyncDecision =
  | { action: 'in_sync'; driftMs: number; targetMediaTime: number }
  | {
      action: 'rate_nudge';
      rate: 0.75 | 1.25;
      driftMs: number;
      targetMediaTime: number;
    }
  | { action: 'seek'; driftMs: number; targetMediaTime: number; seekToTime: number }
  | { action: 'cooldown'; driftMs: number; targetMediaTime: number };

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Extracts an 11-character YouTube video ID from standard watch URLs,
 * youtu.be short links, Shorts, Embed, YouTube Music, or a raw ID.
 */
export function parseYouTubeId(rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input) return null;

  if (YOUTUBE_ID_REGEX.test(input)) {
    return input;
  }

  let normalized = input;
  if (!/^https?:\/\//i.test(normalized) && /(youtube\.com|youtu\.be)/i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();

    if (host === 'youtu.be') {
      const candidate = url.pathname.split('/').filter(Boolean)[0] ?? '';
      return YOUTUBE_ID_REGEX.test(candidate) ? candidate : null;
    }

    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com'
    ) {
      const vParam = url.searchParams.get('v');
      if (vParam && YOUTUBE_ID_REGEX.test(vParam)) {
        return vParam;
      }

      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(segments[0])) {
        const candidate = segments[1];
        return YOUTUBE_ID_REGEX.test(candidate) ? candidate : null;
      }
    }
  } catch {
    // Fallback regex extraction for malformed partial URLs
    const match = input.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (match && YOUTUBE_ID_REGEX.test(match[1])) {
      return match[1];
    }
  }

  return null;
}

export function getYouTubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

const PLAYLIST_ID_RAW_REGEX = /^(PL|UU|LL|FL|OLAK5uy_|RD)[a-zA-Z0-9_-]{8,75}$/;
const PLAYLIST_ID_PARAM_REGEX = /^[a-zA-Z0-9_-]{10,80}$/;

/**
 * Extracts a YouTube playlist ID from playlist URLs, watch?v=...&list=... URLs,
 * youtu.be links with ?list=..., or raw playlist IDs (PL..., OLAK5uy_..., UU..., RD...).
 */
export function parseYouTubePlaylistId(rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input) return null;

  if (PLAYLIST_ID_RAW_REGEX.test(input)) {
    return input;
  }

  let normalized = input;
  if (!/^https?:\/\//i.test(normalized) && /(youtube\.com|youtu\.be)/i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'youtu.be'
    ) {
      const listParam = url.searchParams.get('list')?.trim() ?? '';
      if (listParam && PLAYLIST_ID_PARAM_REGEX.test(listParam) && listParam !== 'WL') {
        return listParam;
      }
    }
  } catch {
    const match = input.match(/[?&]list=([a-zA-Z0-9_-]{10,80})/);
    if (match && PLAYLIST_ID_PARAM_REGEX.test(match[1]) && match[1] !== 'WL') {
      return match[1];
    }
  }

  return null;
}

export interface ParsedPlaylistTrack {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
}

function readYtText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const record = node as {
    simpleText?: unknown;
    runs?: Array<{ text?: unknown }>;
  };
  if (typeof record.simpleText === 'string') {
    return record.simpleText.trim();
  }
  if (Array.isArray(record.runs)) {
    return record.runs
      .map((r) => (typeof r?.text === 'string' ? r.text : ''))
      .join('')
      .trim();
  }
  return '';
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function findNestedObjectsByKey(
  root: unknown,
  targetKey: string,
  out: unknown[] = [],
  depth = 0,
): unknown[] {
  if (!root || typeof root !== 'object' || depth > 24) return out;
  if (Array.isArray(root)) {
    for (const item of root) {
      findNestedObjectsByKey(item, targetKey, out, depth + 1);
    }
    return out;
  }
  const obj = root as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, targetKey)) {
    out.push(obj[targetKey]);
  }
  for (const key of Object.keys(obj)) {
    if (key !== targetKey) {
      findNestedObjectsByKey(obj[key], targetKey, out, depth + 1);
    }
  }
  return out;
}

/**
 * Extracts playlist title & deduplicated tracks from YouTube ytInitialData JSON
 * (supports both /playlist?list=... and /watch?v=...&list=RD... mix panels).
 */
export function extractPlaylistFromInitialData(
  data: unknown,
  maxTracks = 50,
): { title: string; tracks: ParsedPlaylistTrack[] } {
  const seen = new Set<string>();
  const tracks: ParsedPlaylistTrack[] = [];

  const headerTitle =
    readYtText(
      (data as { header?: { playlistHeaderRenderer?: { title?: unknown } } })?.header
        ?.playlistHeaderRenderer?.title,
    ) ||
    String(
      (data as { metadata?: { playlistMetadataRenderer?: { title?: unknown } } })?.metadata
        ?.playlistMetadataRenderer?.title ?? '',
    ).trim() ||
    String(
      (
        data as {
          contents?: {
            twoColumnWatchNextResults?: { playlist?: { playlist?: { title?: unknown } } };
          };
        }
      )?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.title ?? '',
    ).trim();

  const videoRenderers = [
    ...findNestedObjectsByKey(data, 'playlistVideoRenderer'),
    ...findNestedObjectsByKey(data, 'playlistPanelVideoRenderer'),
  ];

  for (const raw of videoRenderers) {
    if (tracks.length >= maxTracks) break;
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as {
      videoId?: unknown;
      title?: unknown;
      shortBylineText?: unknown;
      longBylineText?: unknown;
      isPlayable?: unknown;
    };
    if (item.isPlayable === false) continue;
    const videoId = parseYouTubeId(String(item.videoId ?? ''));
    if (!videoId || seen.has(videoId)) continue;

    const title = readYtText(item.title) || `YouTube Track (${videoId})`;
    if (/^\[(deleted|private) video\]$/i.test(title)) continue;

    const author =
      readYtText(item.shortBylineText) || readYtText(item.longBylineText) || 'YouTube';
    seen.add(videoId);
    tracks.push({
      videoId,
      title,
      author,
      thumbnail: getYouTubeThumbnail(videoId),
    });
  }

  return {
    title: headerTitle || 'YouTube Playlist',
    tracks,
  };
}

/**
 * Extracts playlist title & tracks from YouTube's public Atom RSS feed XML
 * (/feeds/videos.xml?playlist_id=...).
 */
export function extractPlaylistFromAtomXml(
  xml: string,
  maxTracks = 50,
): { title: string; tracks: ParsedPlaylistTrack[] } {
  const beforeEntries = xml.split('<entry>')[0] ?? xml;
  const feedTitleMatch = beforeEntries.match(/<title>([\s\S]*?)<\/title>/i);
  const playlistTitle = feedTitleMatch
    ? decodeXmlEntities(feedTitleMatch[1])
    : 'YouTube Playlist';

  const seen = new Set<string>();
  const tracks: ParsedPlaylistTrack[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    if (tracks.length >= maxTracks) break;
    const entry = match[1];
    const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i);
    const videoId = idMatch ? parseYouTubeId(idMatch[1]) : null;
    if (!videoId || seen.has(videoId)) continue;

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const authorMatch = entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i);

    seen.add(videoId);
    tracks.push({
      videoId,
      title: titleMatch ? decodeXmlEntities(titleMatch[1]) : `YouTube Track (${videoId})`,
      author: authorMatch ? decodeXmlEntities(authorMatch[1]) : 'YouTube',
      thumbnail: getYouTubeThumbnail(videoId),
    });
  }

  return {
    title: playlistTitle || 'YouTube Playlist',
    tracks,
  };
}

/**
 * Validates and normalizes a batch of queued tracks (e.g. from a playlist),
 * filtering invalid IDs and capping batch size.
 */
export function prepareBatchQueueTracks(
  rawTracks: ReadonlyArray<{
    videoId: string;
    title?: string;
    author?: string;
    thumbnail?: string;
  }>,
  maxBatch = 50,
): ParsedPlaylistTrack[] {
  const result: ParsedPlaylistTrack[] = [];
  for (const raw of rawTracks) {
    if (result.length >= maxBatch) break;
    const videoId = parseYouTubeId(String(raw.videoId ?? ''));
    if (!videoId) continue;
    const cleanTitle = raw.title?.trim() || `YouTube Track (${videoId})`;
    const cleanAuthor = raw.author?.trim() || 'YouTube';
    const cleanThumb = raw.thumbnail?.trim() || getYouTubeThumbnail(videoId);
    result.push({
      videoId,
      title: cleanTitle,
      author: cleanAuthor,
      thumbnail: cleanThumb,
    });
  }
  return result;
}

export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/**
 * Extracts a 6-character room code from raw input, ?room=XXXXXX URLs,
 * or /room/XXXXXX paths.
 */
export function extractRoomCodeFromInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';

  const queryMatch = trimmed.match(/[?&]room=([A-Za-z0-9]{1,6})/i);
  if (queryMatch) {
    return normalizeRoomCode(queryMatch[1]);
  }

  const pathMatch = trimmed.match(/\/room\/([A-Za-z0-9]{1,6})/i);
  if (pathMatch) {
    return normalizeRoomCode(pathMatch[1]);
  }

  return normalizeRoomCode(trimmed);
}

/**
 * Builds the canonical shareable invite URL for a normalized 6-char room code.
 */
export function buildRoomInviteUrl(origin: string, roomCode: string): string {
  const normalized = normalizeRoomCode(roomCode);
  const cleanOrigin = origin.replace(/\/+$/, '');
  return cleanOrigin ? `${cleanOrigin}/?room=${normalized}` : `/?room=${normalized}`;
}

/**
 * Purely moves a queue item by id to a target index (clamped to valid bounds)
 * without mutating the input array.
 */
export function reorderQueueItem<T extends { id: string }>(
  queue: readonly T[],
  itemId: string,
  toIndex: number,
): T[] {
  const fromIndex = queue.findIndex((item) => item.id === itemId);
  if (fromIndex === -1 || queue.length <= 1) {
    return [...queue];
  }
  const clampedTarget = Math.max(0, Math.min(queue.length - 1, Math.trunc(toIndex)));
  if (fromIndex === clampedTarget) {
    return [...queue];
  }
  const next = [...queue];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(clampedTarget, 0, moved);
  return next;
}

/**
 * NTP-style single ping sample:
 * t0 = client send epoch ms
 * serverTime = server receive/send epoch ms
 * t1 = client receive epoch ms
 */
export function computeClockSample(
  t0: number,
  serverTime: number,
  t1: number,
): ClockSample {
  const rttMs = Math.max(0, t1 - t0);
  const oneWayMs = rttMs / 2;
  const offsetMs = serverTime + oneWayMs - t1;
  return {
    rttMs,
    offsetMs,
    sampledAt: t1,
  };
}

/**
 * Picks the lowest-RTT sample (lowest network jitter) from recent samples
 * to estimate true clock offset between client and server.
 */
export function selectBestClockOffset(samples: ClockSample[]): {
  offsetMs: number;
  rttMs: number;
} {
  if (samples.length === 0) {
    return { offsetMs: 0, rttMs: 0 };
  }

  let best = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].rttMs < best.rttMs) {
      best = samples[i];
    }
  }

  return {
    offsetMs: Math.round(best.offsetMs),
    rttMs: Math.round(best.rttMs),
  };
}

/**
 * Computes exact authoritative media playback position (in seconds)
 * at a given synchronized server timestamp.
 */
export function computeTargetMediaTime(
  playback: Pick<PlaybackState, 'status' | 'anchorMediaTime' | 'anchorServerTime' | 'playbackRate'>,
  serverNowMs: number,
): number {
  if (playback.status === 'paused' || playback.status === 'buffering') {
    return Math.max(0, playback.anchorMediaTime);
  }
  const elapsedSeconds = (serverNowMs - playback.anchorServerTime) / 1000;
  const projected = playback.anchorMediaTime + elapsedSeconds * playback.playbackRate;
  return Math.max(0, projected);
}

/**
 * Checks whether every currently connected client in the room has reported
 * ready for the active pre-buffer handshake.
 */
export function areAllClientsReady(
  connectedClientIds: readonly string[],
  readyClientIds: readonly string[],
): boolean {
  if (connectedClientIds.length === 0) return false;
  return connectedClientIds.every((id) => readyClientIds.includes(id));
}

export function updateAdaptiveSeekLatency(
  previousMs: number,
  measuredMs: number,
): number {
  const clamped = Math.min(1500, Math.max(60, measuredMs));
  if (!Number.isFinite(previousMs) || previousMs <= 0) {
    return Math.round(clamped);
  }
  return Math.round(previousMs * 0.6 + clamped * 0.4);
}

/**
 * Two-tier drift correction engine:
 * 1. Within ±75ms -> In Sync (imperceptible unison).
 * 2. Between 75ms and 650ms (when player supports 0.75x / 1.25x) ->
 *    Smooth playback-rate nudge so audio never stutters or re-buffers mid-song.
 * 3. Above 650ms (or >180ms without rate nudge) ->
 *    Latency-compensated seek with cooldown to prevent seek-buffer loops.
 */
export function decideSyncCorrection(params: {
  actualMediaTime: number;
  targetMediaTime: number;
  speakerOffsetMs: number;
  nowMs: number;
  lastSeekMs: number;
  supportsRateNudge?: boolean;
  inSyncThresholdMs?: number;
  seekThresholdMs?: number;
  cooldownMs?: number;
  adaptiveSeekLatencyMs?: number;
}): SyncDecision {
  const supportsRateNudge = params.supportsRateNudge ?? true;
  const inSyncThresholdMs = params.inSyncThresholdMs ?? 75;
  const seekThresholdMs = params.seekThresholdMs ?? (supportsRateNudge ? 650 : 180);
  const cooldownMs = params.cooldownMs ?? 2000;
  const seekLatencySec = (params.adaptiveSeekLatencyMs ?? 160) / 1000;

  const adjustedTarget = Math.max(0, params.targetMediaTime + params.speakerOffsetMs / 1000);
  const driftMs = Math.round((params.actualMediaTime - adjustedTarget) * 1000);
  const absDrift = Math.abs(driftMs);

  if (absDrift <= inSyncThresholdMs) {
    return {
      action: 'in_sync',
      driftMs,
      targetMediaTime: adjustedTarget,
    };
  }

  // Wait for post-seek settle window before issuing another correction
  if (params.nowMs - params.lastSeekMs < cooldownMs) {
    return {
      action: 'cooldown',
      driftMs,
      targetMediaTime: adjustedTarget,
    };
  }

  if (supportsRateNudge && absDrift <= seekThresholdMs) {
    return {
      action: 'rate_nudge',
      rate: driftMs < 0 ? 1.25 : 0.75,
      driftMs,
      targetMediaTime: adjustedTarget,
    };
  }

  if (absDrift <= seekThresholdMs) {
    return {
      action: 'in_sync',
      driftMs,
      targetMediaTime: adjustedTarget,
    };
  }

  return {
    action: 'seek',
    driftMs,
    targetMediaTime: adjustedTarget,
    seekToTime: Math.max(0, adjustedTarget + seekLatencySec),
  };
}

export type RttQuality = 'good' | 'fair' | 'poor';
export type NetworkConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

/**
 * Classifies network health from measured RTT (ms) and connection state:
 * - good (green): <= 120ms while connected
 * - fair (yellow): 121-300ms, or actively connecting
 * - poor (red): > 300ms, reconnecting, or offline/unmeasured
 */
export function getRttQuality(
  rttMs: number | null,
  connectionStatus: NetworkConnectionState = 'connected',
): RttQuality {
  if (connectionStatus === 'reconnecting') {
    return 'poor';
  }
  if (connectionStatus === 'connecting') {
    return 'fair';
  }
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs < 0) {
    return connectionStatus === 'disconnected' ? 'poor' : 'fair';
  }
  if (rttMs <= 120) {
    return 'good';
  }
  if (rttMs <= 300) {
    return 'fair';
  }
  return 'poor';
}

export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0:00';
  }
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const CURATED_TRACKS: Omit<TrackItem, 'id' | 'addedBy'>[] = [
  {
    videoId: 'n61ULEU7CO0',
    title: 'Best of lofi hip hop — beats to relax & study',
    author: 'Lofi Girl',
    thumbnail: getYouTubeThumbnail('n61ULEU7CO0'),
  },
  {
    videoId: 'lTRiuFIWV54',
    title: '1 A.M Study Session — Chill Lofi Mix',
    author: 'Lofi Girl',
    thumbnail: getYouTubeThumbnail('lTRiuFIWV54'),
  },
  {
    videoId: 'TURbeWK2wwg',
    title: '4 A.M Study Session — Late Night Beats',
    author: 'Lofi Girl',
    thumbnail: getYouTubeThumbnail('TURbeWK2wwg'),
  },
  {
    videoId: '4xDzrJKXOOY',
    title: 'Synthwave Radio — Chill Synth & Retro Beats',
    author: 'Lofi Girl Synthwave',
    thumbnail: getYouTubeThumbnail('4xDzrJKXOOY'),
  },
];
