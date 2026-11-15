import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeClockSample,
  selectBestClockOffset,
  type ClockSample,
} from '../shared/syncMath';
import type {
  ClientMessage,
  ControlMode,
  DeviceType,
  PlaybackState,
  RoomSnapshot,
  ServerMessage,
} from '../shared/types';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export function detectDeviceType(): DeviceType {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent.toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod/.test(ua)) return 'mobile';
  return 'desktop';
}

interface JoinParams {
  roomCode?: string;
  name: string;
  initialVideoId?: string;
  initialTrack?: {
    title?: string;
    author?: string;
    thumbnail?: string;
  };
  restoreIfMissing?: boolean;
  restorePlayback?: Partial<PlaybackState>;
}

export function useRoomSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const samplesRef = useRef<ClockSample[]>([]);
  const clockOffsetRef = useRef<number>(0);
  const rttMsRef = useRef<number>(0);
  const joinParamsRef = useRef<JoinParams | null>(null);
  const activeRoomCodeRef = useRef<string | null>(null);
  const isHostRef = useRef<boolean>(false);
  const lastPlaybackRef = useRef<PlaybackState | null>(null);
  const intentionalCloseRef = useRef<boolean>(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const syncIntervalRef = useRef<number | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [clientId, setClientId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState<number>(0);
  const [rttMs, setRttMs] = useState<number>(0);
  const [hasRttSample, setHasRttSample] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sendMessage = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const runClockBurst = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < 5; i++) {
      window.setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'sync:ping', t0: Date.now() }));
        }
      }, i * 85);
    }
  }, []);

  const connectAndJoin = useCallback(
    (params: JoinParams) => {
      joinParamsRef.current = params;
      if (!params.restoreIfMissing) {
        activeRoomCodeRef.current = params.roomCode ?? null;
        isHostRef.current = false;
        lastPlaybackRef.current = null;
        setHasRttSample(false);
      }
      intentionalCloseRef.current = false;
      setErrorMsg(null);

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      setConnectionStatus(params.restoreIfMissing ? 'reconnecting' : 'connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
        samplesRef.current = [];
        runClockBurst();

        if (syncIntervalRef.current) {
          window.clearInterval(syncIntervalRef.current);
        }
        syncIntervalRef.current = window.setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'sync:ping', t0: Date.now() }));
          }
        }, 10_000);

        const activeParams = joinParamsRef.current;
        if (activeParams) {
          ws.send(
            JSON.stringify({
              type: 'room:join',
              roomCode: activeRoomCodeRef.current || activeParams.roomCode,
              name: activeParams.name,
              deviceType: detectDeviceType(),
              initialVideoId: activeParams.initialVideoId,
              initialTrack: activeParams.initialTrack,
              restoreIfMissing: activeParams.restoreIfMissing,
              restorePlayback: activeParams.restorePlayback,
            } satisfies ClientMessage),
          );
        }
      };

      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }

        if (msg.type === 'sync:pong') {
          const t1 = Date.now();
          const sample = computeClockSample(msg.t0, msg.serverTime, t1);
          const freshCutoff = t1 - 90_000;
          const retained = samplesRef.current.filter((s) => s.sampledAt >= freshCutoff);
          const nextSamples = [...retained, sample].slice(-12);
          samplesRef.current = nextSamples;
          const best = selectBestClockOffset(nextSamples);
          clockOffsetRef.current = best.offsetMs;
          rttMsRef.current = best.rttMs;
          setClockOffsetMs(best.offsetMs);
          setRttMs(best.rttMs);
          setHasRttSample(true);
          return;
        }

        if (msg.type === 'room:joined') {
          activeRoomCodeRef.current = msg.room.code;
          isHostRef.current = msg.room.hostId === msg.clientId;
          lastPlaybackRef.current = msg.room.playback;
          setClientId(msg.clientId);
          setRoom(msg.room);
          setErrorMsg(null);
          return;
        }

        if (msg.type === 'room:state') {
          activeRoomCodeRef.current = msg.room.code;
          lastPlaybackRef.current = msg.room.playback;
          setRoom(msg.room);
          return;
        }

        if (msg.type === 'room:participants') {
          setRoom((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              hostId: msg.hostId,
              controlMode: msg.controlMode,
              participants: msg.participants,
            };
          });
          setClientId((currId) => {
            if (currId) {
              isHostRef.current = msg.hostId === currId;
            }
            return currId;
          });
          return;
        }

        if (msg.type === 'room:error') {
          setErrorMsg(msg.code === 'ROOM_NOT_FOUND' ? 'ROOM_NOT_FOUND' : msg.message);
          intentionalCloseRef.current = true;
          ws.close();
          setConnectionStatus('disconnected');
        }
      };

      ws.onclose = () => {
        if (syncIntervalRef.current) {
          window.clearInterval(syncIntervalRef.current);
          syncIntervalRef.current = null;
        }
        if (intentionalCloseRef.current || !joinParamsRef.current) {
          setConnectionStatus('disconnected');
          return;
        }
        setConnectionStatus('reconnecting');
        reconnectTimerRef.current = window.setTimeout(() => {
          if (joinParamsRef.current) {
            const targetCode = activeRoomCodeRef.current || joinParamsRef.current.roomCode;
            connectAndJoin({
              ...joinParamsRef.current,
              roomCode: targetCode,
              restoreIfMissing: Boolean(isHostRef.current && targetCode),
              restorePlayback: lastPlaybackRef.current ?? undefined,
            });
          }
        }, 1500);
      };
    },
    [runClockBurst],
  );

  const leaveRoom = useCallback(() => {
    intentionalCloseRef.current = true;
    joinParamsRef.current = null;
    activeRoomCodeRef.current = null;
    isHostRef.current = false;
    lastPlaybackRef.current = null;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (syncIntervalRef.current) {
      window.clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setRoom(null);
    setClientId(null);
    setHasRttSample(false);
    setErrorMsg(null);
    setConnectionStatus('disconnected');
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        runClockBurst();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [runClockBurst]);

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (syncIntervalRef.current) window.clearInterval(syncIntervalRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  const getServerNow = useCallback(() => {
    return Date.now() + clockOffsetRef.current;
  }, []);

  return {
    connectionStatus,
    clientId,
    room,
    clockOffsetMs,
    rttMs,
    hasRttSample,
    errorMsg,
    clearError: () => setErrorMsg(null),
    getServerNow,
    triggerClockSync: runClockBurst,
    connectAndJoin,
    leaveRoom,
    play: (mediaTime?: number) =>
      sendMessage({ type: 'playback:play', mediaTime, scheduleDelayMs: 320 }),
    pause: (mediaTime: number) => sendMessage({ type: 'playback:pause', mediaTime }),
    seek: (mediaTime: number) => sendMessage({ type: 'playback:seek', mediaTime }),
    resyncAll: (mediaTime: number) =>
      sendMessage({ type: 'playback:resync_all', mediaTime }),
    reportBufferReady: (revision: number) =>
      sendMessage({ type: 'playback:ready', revision }),
    forceStartPlayback: () => sendMessage({ type: 'playback:force_start' }),
    loadTrack: (track: {
      videoId: string;
      title?: string;
      author?: string;
      thumbnail?: string;
      autoplay?: boolean;
    }) => sendMessage({ type: 'track:load', ...track }),
    addToQueue: (track: {
      videoId: string;
      title?: string;
      author?: string;
      thumbnail?: string;
    }) => sendMessage({ type: 'queue:add', ...track }),
    addBatchToQueue: (
      tracks: Array<{
        videoId: string;
        title?: string;
        author?: string;
        thumbnail?: string;
      }>,
      playFirst = false,
    ) => sendMessage({ type: 'queue:add_batch', tracks, playFirst }),
    removeFromQueue: (itemId: string) => sendMessage({ type: 'queue:remove', itemId }),
    clearQueue: () => sendMessage({ type: 'queue:clear' }),
    reorderQueue: (itemId: string, toIndex: number) =>
      sendMessage({ type: 'queue:reorder', itemId, toIndex }),
    playQueueItem: (itemId: string) => sendMessage({ type: 'queue:play_item', itemId }),
    reportTrackEnded: (currentVideoId: string) =>
      sendMessage({ type: 'track:ended', currentVideoId }),
    setControlMode: (controlMode: ControlMode) =>
      sendMessage({ type: 'room:set_control_mode', controlMode }),
    transferHost: (targetClientId: string) =>
      sendMessage({ type: 'room:transfer_host', targetClientId }),
    sendTelemetry: (driftMs: number, audioUnlocked: boolean) =>
      sendMessage({
        type: 'client:telemetry',
        rttMs: rttMsRef.current,
        driftMs,
        audioUnlocked,
      }),
  };
}
