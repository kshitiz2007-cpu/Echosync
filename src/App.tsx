import { useEffect, useRef, useState } from 'react';
import {
  extractRoomCodeFromInput,
  normalizeRoomCode,
  type NetworkConnectionState,
} from './shared/syncMath';
import type { Language } from './shared/types';
import { useRoomSocket } from './hooks/useRoomSocket';
import { TopBar } from './components/TopBar';
import { LobbyView } from './components/LobbyView';
import { RoomView } from './components/RoomView';
import { OfflineBanner } from './components/OfflineBanner';

function getInitialRoomParam(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const fromQuery = normalizeRoomCode(params.get('room') ?? '');
  if (fromQuery.length === 6) return fromQuery;
  const fromPath = extractRoomCodeFromInput(window.location.pathname);
  return fromPath.length === 6 ? fromPath : '';
}

function getAutostartParam(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('autostart') === '1';
}

export default function App() {
  const [lang, setLang] = useState<Language>('hi');
  const [prefilledRoomCode, setPrefilledRoomCode] = useState<string>(getInitialRoomParam);
  const [probeRttMs, setProbeRttMs] = useState<number | null>(null);
  const [probeStatus, setProbeStatus] = useState<NetworkConnectionState>('connecting');
  const autostartDoneRef = useRef(false);

  const socket = useRoomSocket();
  const inRoom = Boolean(socket.room && socket.clientId);

  // Measure lightweight HTTP RTT when outside a WebSocket room so TopBar stays live
  useEffect(() => {
    if (inRoom) return;
    let active = true;

    const measureProbe = async () => {
      const started = performance.now();
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!active) return;
        if (res.ok) {
          setProbeRttMs(Math.max(1, Math.round(performance.now() - started)));
          setProbeStatus('connected');
        } else {
          setProbeRttMs(null);
          setProbeStatus('disconnected');
        }
      } catch {
        if (!active) return;
        setProbeRttMs(null);
        setProbeStatus('disconnected');
      }
    };

    void measureProbe();
    const timer = window.setInterval(() => {
      void measureProbe();
    }, 15_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [inRoom]);

  const topBarNetworkStatus: NetworkConnectionState =
    socket.connectionStatus !== 'disconnected' ? socket.connectionStatus : probeStatus;
  const topBarRttMs: number | null =
    socket.connectionStatus !== 'disconnected'
      ? socket.hasRttSample
        ? socket.rttMs
        : probeRttMs
      : probeRttMs;

  // Sync browser URL ?room=CODE without reloading
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (socket.room?.code) {
      url.searchParams.set('room', socket.room.code);
      window.history.replaceState({}, '', url.toString());
      setPrefilledRoomCode(socket.room.code);
    }
  }, [socket.room?.code]);

  // Support ?autostart=1 for instant demo room creation
  useEffect(() => {
    if (autostartDoneRef.current) return;
    if (getAutostartParam()) {
      autostartDoneRef.current = true;
      const roomParam = getInitialRoomParam();
      if (roomParam.length === 6) {
        socket.connectAndJoin({ roomCode: roomParam, name: 'Listener' });
      } else {
        socket.connectAndJoin({ name: 'Host Studio' });
      }
    }
  }, [socket]);

  const handleLeaveRoom = () => {
    socket.leaveRoom();
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      url.searchParams.delete('autostart');
      window.history.replaceState({}, '', url.toString());
    }
    setPrefilledRoomCode('');
  };

  const handleNavigateSection = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleTopBarPrimary = () => {
    if (inRoom) {
      handleLeaveRoom();
    } else {
      const createInput = document.getElementById('host-user-name');
      if (createInput) {
        createInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        createInput.focus();
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F3F4F6] flex flex-col">
      <TopBar
        lang={lang}
        inRoom={inRoom}
        rttMs={topBarRttMs}
        networkStatus={topBarNetworkStatus}
        onPrimaryAction={handleTopBarPrimary}
        onNavigateSection={handleNavigateSection}
      />

      <div className="flex-1">
        {inRoom && socket.room && socket.clientId ? (
          <RoomView
            room={socket.room}
            clientId={socket.clientId}
            lang={lang}
            onChangeLang={setLang}
            connectionStatus={socket.connectionStatus}
            rttMs={socket.rttMs}
            getServerNow={socket.getServerNow}
            onTriggerClockSync={socket.triggerClockSync}
            onPlay={socket.play}
            onPause={socket.pause}
            onSeek={socket.seek}
            onResyncAll={socket.resyncAll}
            onBufferReady={socket.reportBufferReady}
            onForceStart={socket.forceStartPlayback}
            onLoadTrack={socket.loadTrack}
            onAddToQueue={socket.addToQueue}
            onAddBatchToQueue={socket.addBatchToQueue}
            onRemoveFromQueue={socket.removeFromQueue}
            onClearQueue={socket.clearQueue}
            onReorderQueue={socket.reorderQueue}
            onPlayQueueItem={socket.playQueueItem}
            onTrackEnded={socket.reportTrackEnded}
            onSetControlMode={socket.setControlMode}
            onTransferHost={socket.transferHost}
            onTelemetry={socket.sendTelemetry}
          />
        ) : (
          <LobbyView
            lang={lang}
            onChangeLang={setLang}
            prefilledRoomCode={prefilledRoomCode}
            externalError={socket.errorMsg}
            isConnecting={socket.connectionStatus === 'connecting'}
            onCreateRoom={(params) => socket.connectAndJoin(params)}
            onJoinRoom={(params) => socket.connectAndJoin(params)}
          />
        )}
      </div>

      <OfflineBanner lang={lang} />

      <footer className="border-t border-white/10 py-6 text-center text-xs text-[#6B7280]">
        <p>EchoSync · Multi-Device YouTube Sync</p>
      </footer>
    </div>
  );
}
