import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Crown,
  Download,
  GripVertical,
  Laptop,
  ListMusic,
  ListPlus,
  Loader2,
  Maximize2,
  Play,
  Plus,
  QrCode,
  Search,
  Smartphone,
  Tablet,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  CURATED_TRACKS,
  buildRoomInviteUrl,
  parseYouTubeId,
  parseYouTubePlaylistId,
  type ParsedPlaylistTrack,
} from '../shared/syncMath';
import type { ControlMode, DeviceType, Language, RoomSnapshot } from '../shared/types';
import type { ConnectionStatus } from '../hooks/useRoomSocket';
import { t } from '../i18n/translations';
import { YouTubeSyncPlayer } from './YouTubeSyncPlayer';
import { QrShareModal } from './QrShareModal';
import { SafeThumb } from './SafeThumb';

interface SearchResultItem {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
}

interface RoomViewProps {
  room: RoomSnapshot;
  clientId: string;
  lang: Language;
  onChangeLang: (lang: Language) => void;
  connectionStatus: ConnectionStatus;
  rttMs: number;
  getServerNow: () => number;
  onTriggerClockSync?: () => void;
  onPlay: (mediaTime?: number) => void;
  onPause: (mediaTime: number) => void;
  onSeek: (mediaTime: number) => void;
  onResyncAll: (mediaTime: number) => void;
  onBufferReady: (revision: number) => void;
  onForceStart: () => void;
  onLoadTrack: (track: {
    videoId: string;
    title?: string;
    author?: string;
    thumbnail?: string;
    autoplay?: boolean;
  }) => void;
  onAddToQueue: (track: {
    videoId: string;
    title?: string;
    author?: string;
    thumbnail?: string;
  }) => void;
  onAddBatchToQueue: (
    tracks: Array<{
      videoId: string;
      title?: string;
      author?: string;
      thumbnail?: string;
    }>,
    playFirst?: boolean,
  ) => void;
  onRemoveFromQueue: (itemId: string) => void;
  onClearQueue: () => void;
  onReorderQueue: (itemId: string, toIndex: number) => void;
  onPlayQueueItem: (itemId: string) => void;
  onTrackEnded: (videoId: string) => void;
  onSetControlMode: (mode: ControlMode) => void;
  onTransferHost: (targetClientId: string) => void;
  onTelemetry: (driftMs: number, audioUnlocked: boolean) => void;
}

function DeviceIcon({ type }: { type: DeviceType }) {
  if (type === 'mobile') return <Smartphone className="h-4 w-4 text-[#9CA3AF] shrink-0" />;
  if (type === 'tablet') return <Tablet className="h-4 w-4 text-[#9CA3AF] shrink-0" />;
  return <Laptop className="h-4 w-4 text-[#9CA3AF] shrink-0" />;
}

export function RoomView({
  room,
  clientId,
  lang,
  onChangeLang,
  connectionStatus,
  rttMs,
  getServerNow,
  onTriggerClockSync,
  onPlay,
  onPause,
  onSeek,
  onResyncAll,
  onBufferReady,
  onForceStart,
  onLoadTrack,
  onAddToQueue,
  onAddBatchToQueue,
  onRemoveFromQueue,
  onClearQueue,
  onReorderQueue,
  onPlayQueueItem,
  onTrackEnded,
  onSetControlMode,
  onTransferHost,
  onTelemetry,
}: RoomViewProps) {
  const isHost = room.hostId === clientId;
  const canControl = room.controlMode === 'everyone' || isHost;

  const [trackInput, setTrackInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [loadedPlaylist, setLoadedPlaylist] = useState<{
    playlistId: string;
    title: string;
    tracks: ParsedPlaylistTrack[];
  } | null>(null);
  const [playlistAddedCount, setPlaylistAddedCount] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [inlineQrUrl, setInlineQrUrl] = useState('');
  const [localDriftMs, setLocalDriftMs] = useState(0);
  const [mobileTab, setMobileTab] = useState<'devices' | 'queue'>('devices');
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);

  const trimmedTrackInput = trackInput.trim();
  const detectedVideoId = parseYouTubeId(trimmedTrackInput);
  const detectedPlaylistId = parseYouTubePlaylistId(trimmedTrackInput);

  const isPrivatePreview =
    typeof window !== 'undefined' && window.location.hostname.startsWith('ais-dev-');
  const publicAppUrl =
    isPrivatePreview && typeof window !== 'undefined'
      ? window.location.origin.replace('://ais-dev-', '://ais-pre-')
      : '';
  const inviteUrl = buildRoomInviteUrl(
    typeof window !== 'undefined' ? window.location.origin : '',
    room.code,
  );

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(inviteUrl, {
      width: 240,
      margin: 1,
      color: {
        dark: '#0B0D11',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (active) setInlineQrUrl(url);
      })
      .catch(() => {
        if (active) setInlineQrUrl('');
      });
    return () => {
      active = false;
    };
  }, [inviteUrl]);

  const handleCopyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const handleTrackAction = async (mode: 'play' | 'queue') => {
    setInputError(null);
    const trimmed = trackInput.trim();
    if (!trimmed) return;

    const directId = parseYouTubeId(trimmed);
    if (directId) {
      let meta: { title?: string; author?: string; thumbnail?: string } = {};
      try {
        const res = await fetch(`/api/youtube/meta?id=${encodeURIComponent(directId)}`);
        if (res.ok) {
          meta = await res.json();
        }
      } catch {
        // Fallback to server-side lookup
      }

      if (mode === 'play') {
        if (!canControl) return;
        onLoadTrack({ videoId: directId, ...meta, autoplay: true });
      } else {
        onAddToQueue({ videoId: directId, ...meta });
      }
      setTrackInput('');
      setSearchResults([]);
      setHasSearched(false);
      return;
    }

    // Otherwise run search
    setIsSearching(true);
    setHasSearched(true);
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(trimmed)}`);
      if (res.ok) {
        const data = (await res.json()) as { items?: SearchResultItem[] };
        setSearchResults(data.items ?? []);
      } else {
        setSearchResults([]);
      }
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleLoadPlaylist = async (playlistId: string, seedVideoId?: string | null) => {
    setInputError(null);
    setPlaylistAddedCount(null);
    setSearchResults([]);
    setHasSearched(false);
    setIsLoadingPlaylist(true);
    try {
      const params = new URLSearchParams({ list: playlistId });
      if (seedVideoId) params.set('v', seedVideoId);
      const res = await fetch(`/api/youtube/playlist?${params.toString()}`);
      if (!res.ok) {
        setLoadedPlaylist(null);
        setInputError(t(lang, 'playlistErrorNotFound'));
        return;
      }
      const data = (await res.json()) as {
        playlistId: string;
        title: string;
        tracks: ParsedPlaylistTrack[];
      };
      if (!data.tracks || data.tracks.length === 0) {
        setLoadedPlaylist(null);
        setInputError(t(lang, 'playlistErrorNotFound'));
        return;
      }
      setLoadedPlaylist(data);
    } catch {
      setLoadedPlaylist(null);
      setInputError(t(lang, 'playlistErrorNotFound'));
    } finally {
      setIsLoadingPlaylist(false);
    }
  };

  const handleQueueLoadedPlaylist = (playFirst: boolean) => {
    if (!loadedPlaylist || loadedPlaylist.tracks.length === 0) return;
    const count = loadedPlaylist.tracks.length;
    onAddBatchToQueue(loadedPlaylist.tracks, playFirst);
    setLoadedPlaylist(null);
    setTrackInput('');
    setInputError(null);
    setPlaylistAddedCount(count);
    window.setTimeout(() => setPlaylistAddedCount(null), 3500);
  };

  const handleSearchFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (detectedPlaylistId && !detectedVideoId) {
      void handleLoadPlaylist(detectedPlaylistId, null);
      return;
    }
    if (detectedVideoId && canControl) {
      void handleTrackAction('play');
    } else if (detectedVideoId) {
      void handleTrackAction('queue');
    } else {
      void handleTrackAction('queue');
    }
  };

  const syncLabel = (() => {
    if (connectionStatus === 'reconnecting') return t(lang, 'syncStatusReconnecting');
    if (connectionStatus === 'connecting') return t(lang, 'syncStatusConnecting');
    if (room.playback.status === 'buffering') return t(lang, 'bufferingSyncStatus');
    if (room.playback.status === 'paused') return t(lang, 'syncStatusPaused');
    if (Math.abs(localDriftMs) <= 100) return t(lang, 'syncStatusInSync');
    return t(lang, 'syncStatusAdjusting');
  })();

  const syncColorClass =
    connectionStatus !== 'connected'
      ? 'text-[#D97706]'
      : room.playback.status === 'buffering'
        ? 'text-[#D97706]'
        : room.playback.status === 'paused'
          ? 'text-[#9CA3AF]'
          : Math.abs(localDriftMs) <= 100
            ? 'text-[#16A34A]'
            : 'text-[#D97706]';

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Room Workspace Control Bar */}
      <section
        aria-label="Room controls"
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#161A23] px-4 py-3 sm:px-6"
      >
        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
          <div>
            <span className="block text-[11px] text-[#9CA3AF]">
              {t(lang, 'roomCodeTag')}
            </span>
            <span
              data-testid="room-code-display"
              className="font-mono-tabular text-lg sm:text-xl font-bold tracking-[0.2em] text-white"
            >
              {room.code}
            </span>
          </div>

          <div className="h-8 w-px bg-white/10 hidden sm:block" aria-hidden="true" />

          <div className="flex items-center gap-2 text-xs sm:text-sm">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connectionStatus === 'connected'
                  ? room.playback.status === 'playing'
                    ? 'bg-[#16A34A]'
                    : 'bg-[#9CA3AF]'
                  : 'bg-[#D97706]'
              }`}
              aria-hidden="true"
            />
            <span className={`font-medium ${syncColorClass}`}>{syncLabel}</span>
            <span className="text-[#6B7280]" aria-hidden="true">
              ·
            </span>
            <span className="font-mono-tabular text-[#9CA3AF]">
              RTT {rttMs}ms
            </span>
            {room.playback.status === 'playing' && (
              <>
                <span className="text-[#6B7280]" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono-tabular text-[#9CA3AF]">
                  {localDriftMs >= 0 ? `+${localDriftMs}ms` : `${localDriftMs}ms`}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCopyInvite}
            className="min-h-[40px] px-3.5 rounded-lg border border-white/10 bg-[#0B0D11] text-xs sm:text-sm font-medium text-[#E5E7EB] hover:bg-white/5 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? <Check className="h-4 w-4 text-[#16A34A]" /> : <Copy className="h-4 w-4" />}
            <span>{copied ? t(lang, 'copiedLink') : t(lang, 'copyLink')}</span>
          </button>

          <button
            type="button"
            onClick={() => setQrOpen(true)}
            className="min-h-[40px] px-3.5 rounded-lg border border-white/10 bg-[#0B0D11] text-xs sm:text-sm font-medium text-[#E5E7EB] hover:bg-white/5 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <QrCode className="h-4 w-4" />
            <span>{t(lang, 'showQr')}</span>
          </button>

          <div
            role="group"
            aria-label={t(lang, 'languageLabel')}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0B0D11] p-1"
          >
            <button
              type="button"
              onClick={() => onChangeLang('hi')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                lang === 'hi' ? 'bg-[#EF4444] text-white' : 'text-[#9CA3AF] hover:text-white'
              }`}
            >
              हिंदी
            </button>
            <button
              type="button"
              onClick={() => onChangeLang('en')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                lang === 'en' ? 'bg-[#EF4444] text-white' : 'text-[#9CA3AF] hover:text-white'
              }`}
            >
              EN
            </button>
          </div>
        </div>
      </section>

      {/* Main 12-Column Studio Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Main Stage: Player + Track Loader */}
        <div className="lg:col-span-8 space-y-6">
          <YouTubeSyncPlayer
            playback={room.playback}
            participantCount={room.participants.length}
            canControl={canControl}
            lang={lang}
            getServerNow={getServerNow}
            onTriggerClockSync={onTriggerClockSync}
            onPlay={onPlay}
            onPause={onPause}
            onSeek={onSeek}
            onResyncAll={onResyncAll}
            onBufferReady={onBufferReady}
            onForceStart={onForceStart}
            onTrackEnded={onTrackEnded}
            onTelemetry={onTelemetry}
            onDriftChange={setLocalDriftMs}
          />

          {/* Track URL Paste / Search Loader */}
          <section
            id="track-loader"
            className="rounded-2xl border border-white/10 bg-[#161A23] p-4 sm:p-6 space-y-4"
          >
            <h2 className="font-display text-base sm:text-lg font-semibold text-white">
              {t(lang, 'loadTrackHeading')}
            </h2>

            <form onSubmit={handleSearchFormSubmit} className="flex flex-col sm:flex-row gap-2.5">
              <div className="relative flex-1">
                <label htmlFor="youtube-track-input" className="sr-only">
                  {t(lang, 'youtubeInputPlaceholder')}
                </label>
                <input
                  id="youtube-track-input"
                  type="text"
                  value={trackInput}
                  onChange={(e) => setTrackInput(e.target.value)}
                  placeholder={t(lang, 'youtubeInputPlaceholder')}
                  className="w-full min-h-[44px] rounded-xl border border-white/10 bg-[#0B0D11] px-4 text-sm text-white placeholder:text-[#6B7280] focus:border-[#EF4444] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {canControl && detectedVideoId && (
                  <button
                    type="button"
                    onClick={() => void handleTrackAction('play')}
                    className="min-h-[44px] px-4 rounded-xl bg-[#EF4444] text-white text-sm font-semibold hover:bg-[#DC2626] transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <Play className="h-4 w-4" />
                    <span>{t(lang, 'playNow')}</span>
                  </button>
                )}

                {detectedVideoId && (
                  <button
                    type="button"
                    onClick={() => void handleTrackAction('queue')}
                    className="min-h-[44px] px-4 rounded-xl border border-white/15 bg-[#0B0D11] text-sm font-medium text-white hover:bg-white/5 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                    <span>{t(lang, 'addToQueue')}</span>
                  </button>
                )}

                {detectedPlaylistId && (
                  <button
                    type="button"
                    data-testid="load-playlist-btn"
                    disabled={isLoadingPlaylist}
                    onClick={() => void handleLoadPlaylist(detectedPlaylistId, detectedVideoId)}
                    className={`min-h-[44px] px-4 rounded-xl text-sm font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                      !detectedVideoId
                        ? 'bg-[#EF4444] text-white hover:bg-[#DC2626]'
                        : 'border border-white/15 bg-[#0B0D11] text-white hover:bg-white/5'
                    }`}
                  >
                    {isLoadingPlaylist ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ListPlus className="h-4 w-4" />
                    )}
                    <span>
                      {isLoadingPlaylist ? t(lang, 'loadingPlaylist') : t(lang, 'loadPlaylist')}
                    </span>
                  </button>
                )}

                {!detectedVideoId && !detectedPlaylistId && (
                  <button
                    type="submit"
                    disabled={isSearching || !trimmedTrackInput}
                    className="min-h-[44px] px-4 rounded-xl border border-white/15 bg-[#0B0D11] text-sm font-medium text-white hover:bg-white/5 disabled:opacity-40 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <Search className="h-4 w-4" />
                    <span>{isSearching ? '...' : 'YouTube'}</span>
                  </button>
                )}
              </div>
            </form>

            {inputError && (
              <p role="alert" className="text-xs text-[#F87171]">
                {inputError}
              </p>
            )}

            {playlistAddedCount !== null && (
              <p
                data-testid="playlist-queued-toast"
                role="status"
                className="text-xs font-medium text-[#16A34A] flex items-center gap-1.5"
              >
                <Check className="h-3.5 w-3.5" />
                <span>
                  {t(lang, 'playlistQueuedToast')} ({playlistAddedCount})
                </span>
              </p>
            )}

            {/* Playlist Preview & Batch Queue Drawer */}
            {loadedPlaylist && (
              <div
                data-testid="playlist-preview-card"
                className="rounded-xl border border-white/15 bg-[#0B0D11] p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">
                      {loadedPlaylist.title}
                    </p>
                    <p className="text-xs text-[#9CA3AF] font-mono-tabular">
                      {loadedPlaylist.tracks.length} {t(lang, 'playlistTracksCount')}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={t(lang, 'close')}
                    onClick={() => setLoadedPlaylist(null)}
                    className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-white/10 text-[#9CA3AF] hover:text-white cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <ul className="max-h-56 overflow-y-auto divide-y divide-white/10 pr-1">
                  {loadedPlaylist.tracks.map((track, index) => (
                    <li
                      key={track.videoId}
                      className="py-2 flex items-center justify-between gap-2.5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="font-mono-tabular text-[11px] text-[#6B7280] w-5 shrink-0">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <SafeThumb
                          src={track.thumbnail}
                          alt={track.title}
                          className="h-9 w-16 rounded-md object-cover bg-[#161A23] shrink-0"
                        />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-white truncate">{track.title}</p>
                          <p className="text-[11px] text-[#9CA3AF] truncate">{track.author}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`${t(lang, 'excludeTrack')} ${track.title}`}
                        onClick={() =>
                          setLoadedPlaylist((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  tracks: prev.tracks.filter((tItem) => tItem.videoId !== track.videoId),
                                }
                              : null,
                          )
                        }
                        className="min-h-[30px] min-w-[30px] flex items-center justify-center rounded-lg text-[#6B7280] hover:text-[#F87171] hover:bg-white/5 shrink-0 cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-white/10">
                  <button
                    type="button"
                    data-testid="queue-playlist-all-btn"
                    disabled={loadedPlaylist.tracks.length === 0}
                    onClick={() => handleQueueLoadedPlaylist(false)}
                    className="min-h-[38px] px-3.5 rounded-lg border border-white/15 bg-[#161A23] text-xs font-semibold text-white hover:bg-white/5 disabled:opacity-40 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <ListPlus className="h-3.5 w-3.5 text-[#EF4444]" />
                    <span>
                      {t(lang, 'queuePlaylistAll')} ({loadedPlaylist.tracks.length})
                    </span>
                  </button>
                  {canControl && (
                    <button
                      type="button"
                      data-testid="play-playlist-btn"
                      disabled={loadedPlaylist.tracks.length === 0}
                      onClick={() => handleQueueLoadedPlaylist(true)}
                      className="min-h-[38px] px-3.5 rounded-lg bg-[#EF4444] text-xs font-semibold text-white hover:bg-[#DC2626] disabled:opacity-40 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span>{t(lang, 'playPlaylistFirst')}</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Search Results */}
            {hasSearched && (
              <div className="space-y-2 pt-2 border-t border-white/10">
                <p className="text-xs font-medium text-[#9CA3AF]">
                  {t(lang, 'searchResults')}
                </p>
                {searchResults.length === 0 && !isSearching ? (
                  <p className="text-xs sm:text-sm text-[#9CA3AF]">
                    {t(lang, 'noSearchResults')}
                  </p>
                ) : (
                  <ul className="divide-y divide-white/10">
                    {searchResults.map((item) => (
                      <li
                        key={item.videoId}
                        className="py-2.5 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <SafeThumb
                            src={item.thumbnail}
                            alt={item.title}
                            className="h-11 w-20 rounded-lg object-cover bg-[#0B0D11] shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate">
                              {item.title}
                            </p>
                            <p className="text-xs text-[#9CA3AF] truncate">{item.author}</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {canControl && (
                            <button
                              type="button"
                              onClick={() => {
                                onLoadTrack({ ...item, autoplay: true });
                                setSearchResults([]);
                                setHasSearched(false);
                                setTrackInput('');
                              }}
                              className="min-h-[38px] px-3 rounded-lg bg-[#EF4444] text-white text-xs font-medium hover:bg-[#DC2626] transition-colors whitespace-nowrap cursor-pointer"
                            >
                              {t(lang, 'playNow')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              onAddToQueue(item);
                            }}
                            className="min-h-[38px] px-3 rounded-lg border border-white/10 bg-[#0B0D11] text-xs font-medium text-[#E5E7EB] hover:bg-white/5 transition-colors whitespace-nowrap cursor-pointer"
                          >
                            {t(lang, 'addToQueue')}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Quick-load curated strip inside room */}
            <div className="pt-3 border-t border-white/10 flex flex-wrap items-center gap-2">
              {CURATED_TRACKS.map((track) => (
                <button
                  key={track.videoId}
                  type="button"
                  onClick={() =>
                    canControl
                      ? onLoadTrack({ ...track, autoplay: true })
                      : onAddToQueue(track)
                  }
                  className="min-h-[36px] px-3 py-1.5 rounded-lg border border-white/10 bg-[#0B0D11] text-xs text-[#D1D5DB] hover:text-white hover:border-white/25 transition-colors truncate max-w-[220px] cursor-pointer"
                >
                  {track.author}
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Right Collaboration Rail: Devices & Queue */}
        <aside id="room-sidebar" className="lg:col-span-4 space-y-6">
          {/* Mobile Segmented Switch */}
          <div className="flex lg:hidden items-center gap-1 rounded-xl border border-white/10 bg-[#161A23] p-1">
            <button
              type="button"
              onClick={() => setMobileTab('devices')}
              className={`flex-1 min-h-[40px] rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                mobileTab === 'devices' ? 'bg-[#EF4444] text-white' : 'text-[#9CA3AF]'
              }`}
            >
              {t(lang, 'devicesTab')} ({room.participants.length})
            </button>
            <button
              type="button"
              onClick={() => setMobileTab('queue')}
              className={`flex-1 min-h-[40px] rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                mobileTab === 'queue' ? 'bg-[#EF4444] text-white' : 'text-[#9CA3AF]'
              }`}
            >
              {t(lang, 'queueTab')} ({room.queue.length})
            </button>
          </div>

          {/* Connected Devices Panel */}
          <section
            aria-label={t(lang, 'devicesTab')}
            className={`rounded-2xl border border-white/10 bg-[#161A23] p-5 space-y-4 ${
              mobileTab === 'devices' ? 'block' : 'hidden lg:block'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-[#EF4444]" />
                <h2 className="font-display text-base font-semibold text-white">
                  {t(lang, 'devicesTab')}
                </h2>
              </div>
              <span
                data-testid="device-count"
                className="font-mono-tabular text-xs font-semibold text-[#9CA3AF]"
              >
                {room.participants.length}
              </span>
            </div>

            {/* Control Permissions (Host can toggle) */}
            <div className="flex items-center justify-between gap-3 border-y border-white/10 py-2.5">
              <span className="text-xs text-[#9CA3AF]">{t(lang, 'controlModeLabel')}</span>
              {isHost ? (
                <div className="flex items-center gap-1 rounded-lg bg-[#0B0D11] p-1 border border-white/10">
                  <button
                    type="button"
                    onClick={() => onSetControlMode('everyone')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      room.controlMode === 'everyone'
                        ? 'bg-[#EF4444] text-white'
                        : 'text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    {t(lang, 'controlEveryone')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetControlMode('host-only')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      room.controlMode === 'host-only'
                        ? 'bg-[#EF4444] text-white'
                        : 'text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    {t(lang, 'controlHostOnly')}
                  </button>
                </div>
              ) : (
                <span className="text-xs font-medium text-[#E5E7EB]">
                  {room.controlMode === 'everyone'
                    ? t(lang, 'controlEveryone')
                    : t(lang, 'controlHostOnly')}
                </span>
              )}
            </div>

            <ul data-testid="participants-list" className="divide-y divide-white/10">
              {room.participants.map((p) => {
                const isSelf = p.clientId === clientId;
                return (
                  <li
                    key={p.clientId}
                    className="py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <DeviceIcon type={p.deviceType} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-white truncate">
                          <span className="truncate">{p.name}</span>
                          {p.isHost && (
                            <Crown
                              aria-label={t(lang, 'hostBadge')}
                              className="h-3.5 w-3.5 text-[#D97706] shrink-0"
                            />
                          )}
                        </div>
                        <p className="text-[11px] text-[#9CA3AF] font-mono-tabular">
                          {isSelf ? t(lang, 'youBadge') : p.deviceType}
                          <span aria-hidden="true"> · </span>
                          {p.rttMs}ms
                          <span aria-hidden="true"> · </span>
                          {p.driftMs >= 0 ? `+${p.driftMs}ms` : `${p.driftMs}ms`}
                        </p>
                      </div>
                    </div>

                    {isHost && !p.isHost && (
                      <button
                        type="button"
                        onClick={() => onTransferHost(p.clientId)}
                        className="min-h-[34px] px-2.5 rounded-lg border border-white/10 bg-[#0B0D11] text-[11px] font-medium text-[#D1D5DB] hover:text-white hover:border-white/25 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {t(lang, 'makeHost')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Up Next Queue Panel */}
          <section
            id="queue-panel"
            aria-label={t(lang, 'queueTab')}
            className={`rounded-2xl border border-white/10 bg-[#161A23] p-5 space-y-4 ${
              mobileTab === 'queue' ? 'block' : 'hidden lg:block'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ListMusic className="h-4 w-4 text-[#EF4444]" />
                <h2 className="font-display text-base font-semibold text-white">
                  {t(lang, 'queueTab')}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {canControl && room.queue.length > 0 && (
                  <button
                    type="button"
                    data-testid="clear-queue-btn"
                    onClick={onClearQueue}
                    className="min-h-[28px] px-2.5 rounded-md border border-white/10 bg-[#0B0D11] text-[11px] font-medium text-[#9CA3AF] hover:text-[#F87171] hover:border-[#F87171]/40 transition-colors cursor-pointer"
                  >
                    {t(lang, 'clearQueue')}
                  </button>
                )}
                <span
                  data-testid="queue-count"
                  className="font-mono-tabular text-xs font-semibold text-[#9CA3AF]"
                >
                  {room.queue.length}
                </span>
              </div>
            </div>

            {room.queue.length === 0 ? (
              <div className="py-3 space-y-3">
                <p className="text-xs sm:text-sm text-[#9CA3AF]">
                  {t(lang, 'queueEmpty')}
                </p>
                {canControl && (
                  <button
                    type="button"
                    onClick={() => {
                      CURATED_TRACKS.slice(1, 4).forEach((track) => {
                        onAddToQueue(track);
                      });
                    }}
                    className="min-h-[36px] px-3 rounded-lg border border-white/10 bg-[#0B0D11] text-xs font-medium text-[#E5E7EB] hover:text-white hover:border-white/25 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5 text-[#EF4444]" />
                    <span>{t(lang, 'addSampleTracks')}</span>
                  </button>
                )}
              </div>
            ) : (
              <ul
                data-testid="queue-list"
                className="space-y-2.5 max-h-[440px] overflow-y-auto pr-1"
              >
                {room.queue.map((item, idx) => {
                  const isDragOver = dragOverItemId === item.id && draggedItemId !== item.id;
                  return (
                    <li
                      key={item.id}
                      data-testid={`queue-item-${idx}`}
                      draggable={canControl}
                      onDragStart={() => {
                        if (!canControl) return;
                        setDraggedItemId(item.id);
                      }}
                      onDragOver={(e) => {
                        if (!canControl || !draggedItemId) return;
                        e.preventDefault();
                        if (dragOverItemId !== item.id) {
                          setDragOverItemId(item.id);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (canControl && draggedItemId && draggedItemId !== item.id) {
                          onReorderQueue(draggedItemId, idx);
                        }
                        setDraggedItemId(null);
                        setDragOverItemId(null);
                      }}
                      onDragEnd={() => {
                        setDraggedItemId(null);
                        setDragOverItemId(null);
                      }}
                      className={`rounded-xl border bg-[#0B0D11] p-3 space-y-2.5 transition-colors ${
                        isDragOver
                          ? 'border-[#EF4444] bg-[#EF4444]/5'
                          : draggedItemId === item.id
                            ? 'border-white/25 opacity-60'
                            : 'border-white/10'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {canControl && (
                          <span
                            className="text-[#6B7280] cursor-grab active:cursor-grabbing shrink-0"
                            aria-hidden="true"
                          >
                            <GripVertical className="h-4 w-4" />
                          </span>
                        )}
                        <span className="font-mono-tabular text-[11px] font-semibold text-[#6B7280] w-5 shrink-0">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <SafeThumb
                          src={item.thumbnail}
                          alt={item.title}
                          className="h-11 w-20 rounded-lg object-cover bg-[#161A23] shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs sm:text-sm font-medium text-white truncate">
                            {item.title}
                          </p>
                          <p className="text-[11px] text-[#9CA3AF] truncate">
                            {item.author}
                            <span aria-hidden="true"> · </span>
                            {t(lang, 'addedByPrefix')} {item.addedBy}
                          </p>
                        </div>
                      </div>

                      {canControl && (
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/5">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => onReorderQueue(item.id, idx - 1)}
                              aria-label={`${t(lang, 'moveUp')} ${item.title}`}
                              className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-white/10 bg-[#161A23] text-[#D1D5DB] hover:text-white hover:border-white/25 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                            >
                              <ChevronUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === room.queue.length - 1}
                              onClick={() => onReorderQueue(item.id, idx + 1)}
                              aria-label={`${t(lang, 'moveDown')} ${item.title}`}
                              className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-white/10 bg-[#161A23] text-[#D1D5DB] hover:text-white hover:border-white/25 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onPlayQueueItem(item.id)}
                              aria-label={`${t(lang, 'playNow')} ${item.title}`}
                              className="min-h-[32px] px-3 rounded-lg bg-[#EF4444] text-white text-xs font-semibold hover:bg-[#DC2626] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                            >
                              <Play className="h-3 w-3" />
                              <span>{t(lang, 'playNow')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onRemoveFromQueue(item.id)}
                              aria-label={`${t(lang, 'removeFromQueue')} ${item.title}`}
                              className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-white/10 bg-[#161A23] text-[#9CA3AF] hover:text-[#F87171] hover:border-[#F87171]/40 transition-colors cursor-pointer"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Inline Scan-to-Join QR Code Card */}
          <section
            aria-label={t(lang, 'inlineQrTitle')}
            data-testid="inline-qr-card"
            className="rounded-2xl border border-white/10 bg-[#161A23] p-5 space-y-3.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <QrCode className="h-4 w-4 text-[#EF4444]" />
                <h2 className="font-display text-base font-semibold text-white">
                  {t(lang, 'inlineQrTitle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setQrOpen(true)}
                className="min-h-[32px] px-2.5 rounded-lg border border-white/10 bg-[#0B0D11] text-[11px] font-medium text-[#D1D5DB] hover:text-white hover:border-white/25 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Maximize2 className="h-3 w-3" />
                <span>{t(lang, 'enlargeQr')}</span>
              </button>
            </div>

            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setQrOpen(true)}
                aria-label={t(lang, 'showQr')}
                className="rounded-xl bg-white p-2 shrink-0 hover:ring-2 hover:ring-[#EF4444] transition-all cursor-pointer"
              >
                {inlineQrUrl ? (
                  <img
                    src={inlineQrUrl}
                    alt={`Room ${room.code} QR Code`}
                    data-testid="inline-qr-image"
                    className="h-24 w-24 object-contain"
                  />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center text-xs font-mono-tabular text-slate-700">
                    {room.code}
                  </div>
                )}
              </button>

              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <span className="block text-[11px] text-[#9CA3AF]">
                    {t(lang, 'roomCodeTag')}
                  </span>
                  <span className="font-mono-tabular text-base font-bold tracking-[0.18em] text-white">
                    {room.code}
                  </span>
                </div>
                <p className="text-xs text-[#9CA3AF] leading-relaxed">
                  {t(lang, 'inlineQrDesc')}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={handleCopyInvite}
                    className="min-h-[32px] px-2.5 rounded-lg border border-white/10 bg-[#0B0D11] text-[11px] font-medium text-[#E5E7EB] hover:bg-white/5 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-[#16A34A]" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>{copied ? t(lang, 'copiedLink') : t(lang, 'copyLink')}</span>
                  </button>
                  {inlineQrUrl && (
                    <a
                      href={inlineQrUrl}
                      download={`echosync-room-${room.code}.png`}
                      className="min-h-[32px] px-2.5 rounded-lg border border-white/10 bg-[#0B0D11] text-[11px] font-medium text-[#D1D5DB] hover:text-white hover:border-white/25 transition-colors flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Download className="h-3 w-3" />
                      <span>{t(lang, 'downloadQr')}</span>
                    </a>
                  )}
                </div>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <QrShareModal
        open={qrOpen}
        roomCode={room.code}
        inviteUrl={inviteUrl}
        isPrivatePreview={isPrivatePreview}
        publicAppUrl={publicAppUrl}
        lang={lang}
        onClose={() => setQrOpen(false)}
      />
    </main>
  );
}
