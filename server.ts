import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  CURATED_TRACKS,
  areAllClientsReady,
  computeTargetMediaTime,
  extractPlaylistFromAtomXml,
  extractPlaylistFromInitialData,
  getYouTubeThumbnail,
  normalizeRoomCode,
  parseYouTubeId,
  parseYouTubePlaylistId,
  prepareBatchQueueTracks,
  reorderQueueItem,
} from './src/shared/syncMath.ts';
import type {
  ClientMessage,
  ControlMode,
  DeviceType,
  PlaybackState,
  RoomParticipant,
  RoomSnapshot,
  ServerMessage,
  TrackItem,
} from './src/shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;
const ROOMS_SNAPSHOT_FILE = '/tmp/echosync-rooms.json';

interface ConnectedClient {
  clientId: string;
  ws: WebSocket;
  isAlive: boolean;
  roomCode: string | null;
  name: string;
  deviceType: DeviceType;
  rttMs: number;
  driftMs: number;
  audioUnlocked: boolean;
  joinedAt: number;
}

interface ServerRoom {
  code: string;
  hostId: string;
  controlMode: ControlMode;
  playback: PlaybackState;
  queue: TrackItem[];
  clients: Map<string, ConnectedClient>;
  emptySince: number | null;
  readyTimer?: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, ServerRoom>();

function saveRoomsToDisk(): void {
  try {
    const serialized = Array.from(rooms.values()).map((room) => ({
      code: room.code,
      hostId: room.hostId,
      controlMode: room.controlMode,
      playback: room.playback,
      queue: room.queue,
      emptySince: room.emptySince ?? Date.now(),
    }));
    fs.writeFileSync(ROOMS_SNAPSHOT_FILE, JSON.stringify(serialized), 'utf8');
  } catch {
    // Non-fatal if /tmp is unavailable
  }
}

function loadRoomsFromDisk(): void {
  try {
    if (!fs.existsSync(ROOMS_SNAPSHOT_FILE)) return;
    const raw = fs.readFileSync(ROOMS_SNAPSHOT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Array<{
      code: string;
      hostId: string;
      controlMode: ControlMode;
      playback: PlaybackState;
      queue: TrackItem[];
      emptySince: number;
    }>;
    const now = Date.now();
    for (const item of parsed) {
      if (!item.code || now - (item.emptySince || now) > ROOM_IDLE_TTL_MS) continue;
      rooms.set(item.code, {
        code: item.code,
        hostId: item.hostId,
        controlMode: item.controlMode || 'everyone',
        playback: item.playback,
        queue: item.queue || [],
        clients: new Map(),
        emptySince: item.emptySince || now,
      });
    }
  } catch {
    // Ignore corrupted snapshot file
  }
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function fetchYouTubeMeta(videoId: string): Promise<{
  title: string;
  author: string;
  thumbnail: string;
}> {
  const fallback = {
    title: `YouTube Track (${videoId})`,
    author: 'YouTube',
    thumbnail: getYouTubeThumbnail(videoId),
  };

  const curated = CURATED_TRACKS.find((item) => item.videoId === videoId);
  if (curated) {
    return {
      title: curated.title,
      author: curated.author,
      thumbnail: curated.thumbnail,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`;
    const res = await fetch(oembedUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title?.trim() || fallback.title,
      author: data.author_name?.trim() || fallback.author,
      thumbnail: data.thumbnail_url || fallback.thumbnail,
    };
  } catch {
    return fallback;
  }
}

async function searchYouTubeVideos(query: string): Promise<
  Array<{
    videoId: string;
    title: string;
    author: string;
    thumbnail: string;
  }>
> {
  const cleaned = query.trim();
  if (!cleaned) return [];

  // Check if user pasted a direct URL or ID
  const directId = parseYouTubeId(cleaned);
  if (directId) {
    const meta = await fetchYouTubeMeta(directId);
    return [{ videoId: directId, ...meta }];
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(cleaned)}`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error('YouTube search request failed');
    const html = await res.text();
    const marker = 'var ytInitialData = ';
    const startIdx = html.indexOf(marker);
    if (startIdx === -1) throw new Error('No ytInitialData');
    const jsonStart = startIdx + marker.length;
    const endIdx = html.indexOf(';</script>', jsonStart);
    if (endIdx === -1) throw new Error('Malformed ytInitialData');

    const parsed = JSON.parse(html.slice(jsonStart, endIdx));
    const sections =
      parsed?.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents ?? [];

    const results: Array<{
      videoId: string;
      title: string;
      author: string;
      thumbnail: string;
    }> = [];

    for (const section of sections) {
      const items = section?.itemSectionRenderer?.contents ?? [];
      for (const entry of items) {
        const video = entry?.videoRenderer;
        if (!video?.videoId) continue;
        const videoId = String(video.videoId);
        const title =
          video?.title?.runs?.map((r: { text?: string }) => r.text ?? '').join('') ||
          `YouTube Video (${videoId})`;
        const author =
          video?.ownerText?.runs?.map((r: { text?: string }) => r.text ?? '').join('') ||
          'YouTube';
        results.push({
          videoId,
          title,
          author,
          thumbnail: getYouTubeThumbnail(videoId),
        });
        if (results.length >= 8) break;
      }
      if (results.length >= 8) break;
    }

    if (results.length > 0) return results;
  } catch {
    // Fallback to matching curated tracks if external scrape is blocked
  }

  const qLower = cleaned.toLowerCase();
  return CURATED_TRACKS.filter(
    (item) =>
      item.title.toLowerCase().includes(qLower) ||
      item.author.toLowerCase().includes(qLower),
  );
}

async function fetchYouTubePlaylist(
  playlistId: string,
  seedVideoId?: string | null,
): Promise<{
  playlistId: string;
  title: string;
  tracks: Array<{
    videoId: string;
    title: string;
    author: string;
    thumbnail: string;
  }>;
}> {
  const targetUrl =
    playlistId.startsWith('RD') && seedVideoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(seedVideoId)}&list=${encodeURIComponent(playlistId)}`
      : `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      const marker = 'var ytInitialData = ';
      const startIdx = html.indexOf(marker);
      if (startIdx !== -1) {
        const jsonStart = startIdx + marker.length;
        const endIdx = html.indexOf(';</script>', jsonStart);
        if (endIdx !== -1) {
          const parsed = JSON.parse(html.slice(jsonStart, endIdx));
          const extracted = extractPlaylistFromInitialData(parsed, 50);
          if (extracted.tracks.length > 0) {
            return { playlistId, ...extracted };
          }
        }
      }
    }
  } catch {
    // Fall back to official Atom feed below
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`;
    const res = await fetch(feedUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const xml = await res.text();
      const extracted = extractPlaylistFromAtomXml(xml, 50);
      if (extracted.tracks.length > 0) {
        return { playlistId, ...extracted };
      }
    }
  } catch {
    // Return empty if both fail
  }

  return { playlistId, title: 'YouTube Playlist', tracks: [] };
}

function toParticipants(room: ServerRoom): RoomParticipant[] {
  return Array.from(room.clients.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((c) => ({
      clientId: c.clientId,
      name: c.name,
      deviceType: c.deviceType,
      isHost: c.clientId === room.hostId,
      rttMs: c.rttMs,
      driftMs: c.driftMs,
      audioUnlocked: c.audioUnlocked,
      joinedAt: c.joinedAt,
    }));
}

function toRoomSnapshot(room: ServerRoom): RoomSnapshot {
  return {
    code: room.code,
    hostId: room.hostId,
    controlMode: room.controlMode,
    playback: { ...room.playback },
    queue: [...room.queue],
    participants: toParticipants(room),
    serverNow: Date.now(),
  };
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastRoomState(room: ServerRoom): void {
  const snapshot = toRoomSnapshot(room);
  for (const client of room.clients.values()) {
    sendJson(client.ws, { type: 'room:state', room: snapshot });
  }
}

function broadcastParticipants(room: ServerRoom): void {
  const payload: ServerMessage = {
    type: 'room:participants',
    hostId: room.hostId,
    controlMode: room.controlMode,
    participants: toParticipants(room),
  };
  for (const client of room.clients.values()) {
    sendJson(client.ws, payload);
  }
}

function canControl(room: ServerRoom, clientId: string): boolean {
  return room.controlMode === 'everyone' || room.hostId === clientId;
}

function clearReadyTimer(room: ServerRoom): void {
  if (room.readyTimer) {
    clearTimeout(room.readyTimer);
    room.readyTimer = null;
  }
}

function startSynchronizedPlayback(
  room: ServerRoom,
  mediaTime: number,
  delayMs = 360,
): void {
  clearReadyTimer(room);
  const now = Date.now();
  room.playback = {
    ...room.playback,
    status: 'playing',
    anchorMediaTime: Math.max(0, mediaTime),
    anchorServerTime: now + delayMs,
    readyClientIds: undefined,
    readyWaitUntil: undefined,
    revision: room.playback.revision + 1,
  };
  broadcastRoomState(room);
}

function initiatePlaybackOrHandshake(
  room: ServerRoom,
  mediaTime: number,
  singleDeviceDelayMs = 340,
): void {
  clearReadyTimer(room);
  const clampedMediaTime = Math.max(0, mediaTime);
  if (room.clients.size <= 1) {
    startSynchronizedPlayback(room, clampedMediaTime, singleDeviceDelayMs);
    return;
  }

  const now = Date.now();
  const maxWaitMs = 2400;
  room.playback = {
    ...room.playback,
    status: 'buffering',
    anchorMediaTime: clampedMediaTime,
    anchorServerTime: now,
    readyClientIds: [],
    readyWaitUntil: now + maxWaitMs,
    revision: room.playback.revision + 1,
  };
  room.readyTimer = setTimeout(() => {
    room.readyTimer = null;
    if (room.playback.status === 'buffering') {
      startSynchronizedPlayback(room, room.playback.anchorMediaTime, 380);
    }
  }, maxWaitMs);
  broadcastRoomState(room);
}

function removeClientFromRoom(client: ConnectedClient): void {
  if (!client.roomCode) return;
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;

  room.clients.delete(client.clientId);

  if (room.clients.size === 0) {
    clearReadyTimer(room);
    room.emptySince = Date.now();
    return;
  }

  if (room.hostId === client.clientId) {
    const nextHost = Array.from(room.clients.values()).sort(
      (a, b) => a.joinedAt - b.joinedAt,
    )[0];
    if (nextHost) {
      room.hostId = nextHost.clientId;
    }
  }

  broadcastParticipants(room);

  if (room.playback.status === 'buffering') {
    const connectedIds = Array.from(room.clients.keys());
    const readyIds = room.playback.readyClientIds ?? [];
    if (areAllClientsReady(connectedIds, readyIds)) {
      startSynchronizedPlayback(room, room.playback.anchorMediaTime, 380);
    }
  }
}

// Cleanup idle empty rooms periodically
setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [code, room] of rooms.entries()) {
    if (room.clients.size === 0 && room.emptySince && now - room.emptySince > ROOM_IDLE_TTL_MS) {
      rooms.delete(code);
      removed = true;
    }
  }
  if (removed) saveRoomsToDisk();
}, 60_000);

async function startServer(): Promise<void> {
  loadRoomsFromDisk();
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activeRooms: rooms.size, serverTime: Date.now() });
  });

  app.get('/api/youtube/meta', async (req, res) => {
    const rawId = String(req.query.id ?? '');
    const videoId = parseYouTubeId(rawId);
    if (!videoId) {
      res.status(400).json({ error: 'Invalid YouTube video ID or URL' });
      return;
    }
    const meta = await fetchYouTubeMeta(videoId);
    res.json({ videoId, ...meta });
  });

  app.get('/api/youtube/search', async (req, res) => {
    const query = String(req.query.q ?? '');
    const items = await searchYouTubeVideos(query);
    res.json({ items });
  });

  app.get('/api/youtube/playlist', async (req, res) => {
    const rawList = String(req.query.list ?? req.query.url ?? '');
    const playlistId = parseYouTubePlaylistId(rawList);
    if (!playlistId) {
      res.status(400).json({ error: 'Invalid YouTube playlist URL or ID' });
      return;
    }
    const seedVideoId = parseYouTubeId(String(req.query.v ?? ''));
    const data = await fetchYouTubePlaylist(playlistId, seedVideoId);
    if (data.tracks.length === 0) {
      res.status(404).json({ error: 'Playlist not found, private, or empty' });
      return;
    }
    res.json(data);
  });

  app.get('/api/rooms/:code', (req, res) => {
    const code = normalizeRoomCode(req.params.code);
    const room = rooms.get(code);
    if (!room) {
      res.status(404).json({ exists: false });
      return;
    }
    res.json({
      exists: true,
      code: room.code,
      participantCount: room.clients.size,
      trackTitle: room.playback.title,
    });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const client: ConnectedClient = {
      clientId: crypto.randomUUID(),
      ws,
      isAlive: true,
      roomCode: null,
      name: 'Listener',
      deviceType: 'desktop',
      rttMs: 0,
      driftMs: 0,
      audioUnlocked: false,
      joinedAt: Date.now(),
    };

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', async (raw) => {
      client.isAlive = true;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }

      if (msg.type === 'sync:ping') {
        sendJson(ws, {
          type: 'sync:pong',
          t0: msg.t0,
          serverTime: Date.now(),
        });
        return;
      }

      if (msg.type === 'room:join') {
        removeClientFromRoom(client);

        client.name = (msg.name || 'Listener').trim().slice(0, 32) || 'Listener';
        client.deviceType = msg.deviceType || 'desktop';
        client.joinedAt = Date.now();

        const requestedCode = msg.roomCode ? normalizeRoomCode(msg.roomCode) : '';
        let room: ServerRoom | undefined;

        if (requestedCode) {
          room = rooms.get(requestedCode);
          if (!room) {
            if (msg.restoreIfMissing && requestedCode.length === 6) {
              const defaultTrack = CURATED_TRACKS[0];
              const restoredVideoId =
                (msg.restorePlayback?.videoId && parseYouTubeId(msg.restorePlayback.videoId)) ||
                defaultTrack.videoId;
              const meta = await fetchYouTubeMeta(restoredVideoId);
              room = {
                code: requestedCode,
                hostId: client.clientId,
                controlMode: 'everyone',
                playback: {
                  videoId: restoredVideoId,
                  title: msg.restorePlayback?.title || meta.title,
                  author: msg.restorePlayback?.author || meta.author,
                  thumbnail: msg.restorePlayback?.thumbnail || meta.thumbnail,
                  status: msg.restorePlayback?.status === 'playing' ? 'playing' : 'paused',
                  anchorMediaTime: msg.restorePlayback?.anchorMediaTime ?? 0,
                  anchorServerTime: msg.restorePlayback?.anchorServerTime ?? Date.now(),
                  playbackRate: msg.restorePlayback?.playbackRate ?? 1,
                  revision: (msg.restorePlayback?.revision ?? 0) + 1,
                },
                queue: [],
                clients: new Map(),
                emptySince: null,
              };
              rooms.set(requestedCode, room);
            } else {
              sendJson(ws, {
                type: 'room:error',
                code: 'ROOM_NOT_FOUND',
                message: 'Room not found or expired.',
              });
              return;
            }
          }
          room.emptySince = null;
        } else {
          const code = generateRoomCode();
          const defaultTrack = CURATED_TRACKS[0];
          const initialId =
            (msg.initialVideoId && parseYouTubeId(msg.initialVideoId)) || defaultTrack.videoId;
          const meta = await fetchYouTubeMeta(initialId);

          room = {
            code,
            hostId: client.clientId,
            controlMode: 'everyone',
            playback: {
              videoId: initialId,
              title: msg.initialTrack?.title || meta.title,
              author: msg.initialTrack?.author || meta.author,
              thumbnail: msg.initialTrack?.thumbnail || meta.thumbnail,
              status: 'paused',
              anchorMediaTime: 0,
              anchorServerTime: Date.now(),
              playbackRate: 1,
              revision: 1,
            },
            queue: [],
            clients: new Map(),
            emptySince: null,
          };
          rooms.set(code, room);
        }

        client.roomCode = room.code;
        room.clients.set(client.clientId, client);
        saveRoomsToDisk();

        sendJson(ws, {
          type: 'room:joined',
          clientId: client.clientId,
          room: toRoomSnapshot(room),
        });
        broadcastParticipants(room);
        return;
      }

      if (!client.roomCode) return;
      const room = rooms.get(client.roomCode);
      if (!room) return;

      switch (msg.type) {
        case 'client:telemetry': {
          client.rttMs = Math.max(0, Math.round(msg.rttMs));
          client.driftMs = Math.round(msg.driftMs);
          client.audioUnlocked = Boolean(msg.audioUnlocked);
          broadcastParticipants(room);
          break;
        }

        case 'playback:play': {
          if (!canControl(room, client.clientId)) return;
          const now = Date.now();
          const scheduleDelay = Math.min(800, Math.max(150, msg.scheduleDelayMs ?? 320));
          const mediaTime =
            typeof msg.mediaTime === 'number' && Number.isFinite(msg.mediaTime)
              ? Math.max(0, msg.mediaTime)
              : computeTargetMediaTime(room.playback, now);
          initiatePlaybackOrHandshake(room, mediaTime, scheduleDelay);
          break;
        }

        case 'playback:ready': {
          if (room.playback.status !== 'buffering') return;
          if (msg.revision !== room.playback.revision) return;
          const currentReady = room.playback.readyClientIds ?? [];
          if (!currentReady.includes(client.clientId)) {
            room.playback = {
              ...room.playback,
              readyClientIds: [...currentReady, client.clientId],
            };
          }
          const connectedIds = Array.from(room.clients.keys());
          if (areAllClientsReady(connectedIds, room.playback.readyClientIds ?? [])) {
            startSynchronizedPlayback(room, room.playback.anchorMediaTime, 380);
          } else {
            broadcastRoomState(room);
          }
          break;
        }

        case 'playback:force_start': {
          if (!canControl(room, client.clientId)) return;
          if (room.playback.status === 'buffering') {
            startSynchronizedPlayback(room, room.playback.anchorMediaTime, 300);
          }
          break;
        }

        case 'playback:pause': {
          if (!canControl(room, client.clientId)) return;
          clearReadyTimer(room);
          const now = Date.now();
          const mediaTime = Math.max(
            0,
            Number.isFinite(msg.mediaTime)
              ? msg.mediaTime
              : computeTargetMediaTime(room.playback, now),
          );
          room.playback = {
            ...room.playback,
            status: 'paused',
            anchorMediaTime: mediaTime,
            anchorServerTime: now,
            readyClientIds: undefined,
            readyWaitUntil: undefined,
            revision: room.playback.revision + 1,
          };
          broadcastRoomState(room);
          break;
        }

        case 'playback:seek': {
          if (!canControl(room, client.clientId)) return;
          clearReadyTimer(room);
          const now = Date.now();
          const mediaTime = Math.max(0, msg.mediaTime);
          const futureOffset = room.playback.status === 'playing' ? 220 : 0;
          room.playback = {
            ...room.playback,
            anchorMediaTime: mediaTime,
            anchorServerTime: now + futureOffset,
            revision: room.playback.revision + 1,
          };
          broadcastRoomState(room);
          break;
        }

        case 'playback:resync_all': {
          if (!canControl(room, client.clientId)) return;
          const now = Date.now();
          const mediaTime = Math.max(0, msg.mediaTime);
          if (room.playback.status === 'paused') {
            room.playback = {
              ...room.playback,
              anchorMediaTime: mediaTime,
              anchorServerTime: now,
              revision: room.playback.revision + 1,
            };
            broadcastRoomState(room);
          } else {
            initiatePlaybackOrHandshake(room, mediaTime, 350);
          }
          break;
        }

        case 'track:load': {
          if (!canControl(room, client.clientId)) return;
          const videoId = parseYouTubeId(msg.videoId);
          if (!videoId) return;
          clearReadyTimer(room);
          const meta =
            msg.title && msg.author
              ? {
                  title: msg.title,
                  author: msg.author,
                  thumbnail: msg.thumbnail || getYouTubeThumbnail(videoId),
                }
              : await fetchYouTubeMeta(videoId);

          const now = Date.now();
          const autoplay = msg.autoplay ?? true;
          room.playback = {
            videoId,
            title: meta.title,
            author: meta.author,
            thumbnail: meta.thumbnail,
            status: 'paused',
            anchorMediaTime: 0,
            anchorServerTime: now,
            playbackRate: 1,
            readyClientIds: undefined,
            readyWaitUntil: undefined,
            revision: room.playback.revision + 1,
          };
          if (autoplay) {
            initiatePlaybackOrHandshake(room, 0, 450);
          } else {
            broadcastRoomState(room);
          }
          break;
        }

        case 'queue:add': {
          const videoId = parseYouTubeId(msg.videoId);
          if (!videoId) return;
          const meta =
            msg.title && msg.author
              ? {
                  title: msg.title,
                  author: msg.author,
                  thumbnail: msg.thumbnail || getYouTubeThumbnail(videoId),
                }
              : await fetchYouTubeMeta(videoId);

          room.queue.push({
            id: crypto.randomUUID(),
            videoId,
            title: meta.title,
            author: meta.author,
            thumbnail: meta.thumbnail,
            addedBy: client.name,
          });
          broadcastRoomState(room);
          saveRoomsToDisk();
          break;
        }

        case 'queue:add_batch': {
          if (!Array.isArray(msg.tracks)) return;
          const prepared = prepareBatchQueueTracks(msg.tracks, 50);
          if (prepared.length === 0) return;

          const newItems: TrackItem[] = prepared.map((track) => ({
            id: crypto.randomUUID(),
            videoId: track.videoId,
            title: track.title,
            author: track.author,
            thumbnail: track.thumbnail,
            addedBy: client.name,
          }));

          if (msg.playFirst && canControl(room, client.clientId)) {
            const [firstTrack, ...restTracks] = newItems;
            clearReadyTimer(room);
            room.queue.push(...restTracks);
            const now = Date.now();
            room.playback = {
              videoId: firstTrack.videoId,
              title: firstTrack.title,
              author: firstTrack.author,
              thumbnail: firstTrack.thumbnail,
              status: 'paused',
              anchorMediaTime: 0,
              anchorServerTime: now,
              playbackRate: 1,
              readyClientIds: undefined,
              readyWaitUntil: undefined,
              revision: room.playback.revision + 1,
            };
            initiatePlaybackOrHandshake(room, 0, 450);
          } else {
            room.queue.push(...newItems);
            broadcastRoomState(room);
          }
          saveRoomsToDisk();
          break;
        }

        case 'queue:remove': {
          if (!canControl(room, client.clientId)) return;
          room.queue = room.queue.filter((item) => item.id !== msg.itemId);
          broadcastRoomState(room);
          saveRoomsToDisk();
          break;
        }

        case 'queue:clear': {
          if (!canControl(room, client.clientId)) return;
          room.queue = [];
          broadcastRoomState(room);
          saveRoomsToDisk();
          break;
        }

        case 'queue:reorder': {
          if (!canControl(room, client.clientId)) return;
          if (!Number.isFinite(msg.toIndex)) return;
          room.queue = reorderQueueItem(room.queue, msg.itemId, msg.toIndex);
          broadcastRoomState(room);
          break;
        }

        case 'queue:play_item': {
          if (!canControl(room, client.clientId)) return;
          const idx = room.queue.findIndex((item) => item.id === msg.itemId);
          if (idx === -1) return;
          const [selected] = room.queue.splice(idx, 1);
          const now = Date.now();
          room.playback = {
            videoId: selected.videoId,
            title: selected.title,
            author: selected.author,
            thumbnail: selected.thumbnail,
            status: 'paused',
            anchorMediaTime: 0,
            anchorServerTime: now,
            playbackRate: 1,
            readyClientIds: undefined,
            readyWaitUntil: undefined,
            revision: room.playback.revision + 1,
          };
          initiatePlaybackOrHandshake(room, 0, 450);
          break;
        }

        case 'track:ended': {
          // Only advance queue once when current video ends (prefer host or first reporter)
          if (msg.currentVideoId !== room.playback.videoId) return;
          if (client.clientId !== room.hostId && room.controlMode === 'host-only') return;
          clearReadyTimer(room);
          if (room.queue.length === 0) {
            room.playback = {
              ...room.playback,
              status: 'paused',
              anchorMediaTime: 0,
              anchorServerTime: Date.now(),
              readyClientIds: undefined,
              readyWaitUntil: undefined,
              revision: room.playback.revision + 1,
            };
            broadcastRoomState(room);
            return;
          }
          const nextTrack = room.queue.shift()!;
          const now = Date.now();
          room.playback = {
            videoId: nextTrack.videoId,
            title: nextTrack.title,
            author: nextTrack.author,
            thumbnail: nextTrack.thumbnail,
            status: 'paused',
            anchorMediaTime: 0,
            anchorServerTime: now,
            playbackRate: 1,
            readyClientIds: undefined,
            readyWaitUntil: undefined,
            revision: room.playback.revision + 1,
          };
          initiatePlaybackOrHandshake(room, 0, 450);
          break;
        }

        case 'room:set_control_mode': {
          if (client.clientId !== room.hostId) return;
          room.controlMode = msg.controlMode === 'host-only' ? 'host-only' : 'everyone';
          broadcastParticipants(room);
          break;
        }

        case 'room:transfer_host': {
          if (client.clientId !== room.hostId) return;
          if (room.clients.has(msg.targetClientId)) {
            room.hostId = msg.targetClientId;
            broadcastParticipants(room);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      removeClientFromRoom(client);
    });
  });

  // WebSocket keepalive ping for Cloud Run proxies (every 20s)
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }, 20_000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  const isProduction =
    process.env.NODE_ENV === 'production' ||
    (Boolean(process.env.K_SERVICE) && process.env.NODE_ENV !== 'development');

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`EchoSync server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
