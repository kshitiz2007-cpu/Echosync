import { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sun,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  computeTargetMediaTime,
  decideSyncCorrection,
  formatTime,
  updateAdaptiveSeekLatency,
} from '../shared/syncMath';
import type { Language, PlaybackState } from '../shared/types';
import { t } from '../i18n/translations';
import { useWakeLock } from '../hooks/useWakeLock';
import { SafeThumb } from './SafeThumb';

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement | string,
        options: {
          videoId: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (event: { target: YTPlayerInstance }) => void;
            onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void;
            onError?: (event: { data: number }) => void;
          };
        },
      ) => YTPlayerInstance;
      PlayerState: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayerInstance {
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  cueVideoById: (videoId: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  getPlaybackRate?: () => number;
  setPlaybackRate?: (suggestedRate: number) => void;
  getAvailablePlaybackRates?: () => number[];
  setVolume: (volume: number) => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  destroy: () => void;
}

let ytApiPromise: Promise<boolean> | null = null;

function loadYouTubeIframeApi(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.YT?.Player) return Promise.resolve(true);
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<boolean>((resolve) => {
    const timeout = window.setTimeout(() => resolve(false), 6000);
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      if (prevReady) prevReady();
      resolve(Boolean(window.YT?.Player));
    };

    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => {
        window.clearTimeout(timeout);
        resolve(false);
      };
      document.head.appendChild(tag);
    }
  });

  return ytApiPromise;
}

interface YouTubeSyncPlayerProps {
  playback: PlaybackState;
  participantCount: number;
  canControl: boolean;
  lang: Language;
  getServerNow: () => number;
  onTriggerClockSync?: () => void;
  onPlay: (mediaTime?: number) => void;
  onPause: (mediaTime: number) => void;
  onSeek: (mediaTime: number) => void;
  onResyncAll: (mediaTime: number) => void;
  onBufferReady: (revision: number) => void;
  onForceStart: () => void;
  onTrackEnded: (videoId: string) => void;
  onTelemetry: (driftMs: number, audioUnlocked: boolean) => void;
  onDriftChange?: (driftMs: number) => void;
}

export function YouTubeSyncPlayer({
  playback,
  participantCount,
  canControl,
  lang,
  getServerNow,
  onTriggerClockSync,
  onPlay,
  onPause,
  onSeek,
  onResyncAll,
  onBufferReady,
  onForceStart,
  onTrackEnded,
  onTelemetry,
  onDriftChange,
}: YouTubeSyncPlayerProps) {
  const hostContainerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const playbackRef = useRef<PlaybackState>(playback);
  const getServerNowRef = useRef(getServerNow);
  const speakerOffsetRef = useRef<number>(0);
  const lastSeekRef = useRef<number>(0);
  const seekStartedAtMsRef = useRef<number | null>(null);
  const adaptiveSeekLatencyMsRef = useRef<number>(160);
  const activeRateNudgeRef = useRef<number>(1);
  const loadedVideoIdRef = useRef<string>('');
  const lastRevisionAppliedRef = useRef<number>(0);
  const scheduledStartTimerRef = useRef<number | null>(null);
  const audioUnlockedRef = useRef<boolean>(false);
  const currentDriftRef = useRef<number>(0);
  const unexpectedPauseCountRef = useRef<number>(0);
  const readyReportedRevisionRef = useRef<number>(0);
  const bufferReadyTimerRef = useRef<number | null>(null);
  const onBufferReadyRef = useRef(onBufferReady);

  const [ytAvailable, setYtAvailable] = useState<boolean>(true);
  const [playerReady, setPlayerReady] = useState<boolean>(false);
  const [audioUnlocked, setAudioUnlocked] = useState<boolean>(false);
  const [needsGesture, setNeedsGesture] = useState<boolean>(false);
  const [displayTime, setDisplayTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(85);
  const [muted, setMuted] = useState<boolean>(false);
  const [speakerOffsetMs, setSpeakerOffsetMs] = useState<number>(0);
  const [showOffsetSlider, setShowOffsetSlider] = useState<boolean>(false);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [scrubValue, setScrubValue] = useState<number>(0);

  const wakeLock = useWakeLock(
    playback.status === 'playing' || playback.status === 'buffering',
  );

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  useEffect(() => {
    getServerNowRef.current = getServerNow;
  }, [getServerNow]);

  useEffect(() => {
    onBufferReadyRef.current = onBufferReady;
  }, [onBufferReady]);

  useEffect(() => {
    speakerOffsetRef.current = speakerOffsetMs;
  }, [speakerOffsetMs]);

  const resetPlaybackRate = (player: YTPlayerInstance | null) => {
    if (!player) return;
    if (activeRateNudgeRef.current !== 1 && player.setPlaybackRate) {
      player.setPlaybackRate(1);
      activeRateNudgeRef.current = 1;
    }
  };

  const performLatencyCompensatedSeek = (
    player: YTPlayerInstance,
    targetSec: number,
  ) => {
    const compensated = Math.max(0, targetSec + adaptiveSeekLatencyMsRef.current / 1000);
    seekStartedAtMsRef.current = Date.now();
    lastSeekRef.current = Date.now();
    resetPlaybackRate(player);
    player.seekTo(compensated, true);
  };

  const applyAuthoritativeState = (state: PlaybackState) => {
    const player = playerRef.current;
    if (!player) return;

    if (scheduledStartTimerRef.current) {
      window.clearTimeout(scheduledStartTimerRef.current);
      scheduledStartTimerRef.current = null;
    }
    if (bufferReadyTimerRef.current) {
      window.clearTimeout(bufferReadyTimerRef.current);
      bufferReadyTimerRef.current = null;
    }

    resetPlaybackRate(player);
    unexpectedPauseCountRef.current = 0;

    const serverNow = getServerNowRef.current();
    const targetSec = computeTargetMediaTime(state, serverNow) + speakerOffsetRef.current / 1000;
    const clampedTarget = Math.max(0, targetSec);
    const trackChanged = loadedVideoIdRef.current !== state.videoId;

    if (trackChanged) {
      loadedVideoIdRef.current = state.videoId;
      if (state.status === 'playing') {
        seekStartedAtMsRef.current = Date.now();
        lastSeekRef.current = Date.now();
        player.loadVideoById(
          state.videoId,
          Math.max(0, clampedTarget + adaptiveSeekLatencyMsRef.current / 1000),
        );
      } else {
        player.cueVideoById(state.videoId, clampedTarget);
      }
    }

    if (state.status === 'buffering') {
      player.pauseVideo();
      if (!trackChanged) {
        const actual = player.getCurrentTime?.() ?? 0;
        if (Math.abs(actual - clampedTarget) > 0.2) {
          player.seekTo(clampedTarget, true);
          lastSeekRef.current = Date.now();
        }
      }
      setNeedsGesture(false);
      bufferReadyTimerRef.current = window.setTimeout(() => {
        if (
          playbackRef.current.status === 'buffering' &&
          playbackRef.current.revision === state.revision &&
          readyReportedRevisionRef.current !== state.revision
        ) {
          readyReportedRevisionRef.current = state.revision;
          onBufferReadyRef.current(state.revision);
        }
      }, trackChanged ? 320 : 140);
      return;
    }

    if (state.status === 'paused') {
      player.pauseVideo();
      const actual = player.getCurrentTime?.() ?? 0;
      if (Math.abs(actual - clampedTarget) > 0.25) {
        player.seekTo(clampedTarget, true);
        lastSeekRef.current = Date.now();
      }
      setNeedsGesture(false);
      return;
    }

    // Playing state: support scheduled future start timestamp for millisecond unison
    const delayMs = state.anchorServerTime - serverNow;
    if (delayMs > 40 && delayMs < 2000) {
      player.pauseVideo();
      player.seekTo(Math.max(0, state.anchorMediaTime), true);
      lastSeekRef.current = Date.now();
      scheduledStartTimerRef.current = window.setTimeout(() => {
        const p = playerRef.current;
        if (!p || playbackRef.current.status !== 'playing') return;
        seekStartedAtMsRef.current = Date.now();
        p.playVideo();
        lastSeekRef.current = Date.now();
      }, delayMs);
    } else {
      performLatencyCompensatedSeek(player, clampedTarget);
      player.playVideo();
    }
  };

  // Mount YouTube IFrame player once
  useEffect(() => {
    let cancelled = false;

    loadYouTubeIframeApi().then((loaded) => {
      if (cancelled) return;
      if (!loaded || !window.YT?.Player || !hostContainerRef.current) {
        setYtAvailable(false);
        return;
      }

      const mountNode = document.createElement('div');
      mountNode.className = 'w-full h-full';
      hostContainerRef.current.innerHTML = '';
      hostContainerRef.current.appendChild(mountNode);

      const initial = playbackRef.current;
      loadedVideoIdRef.current = initial.videoId;

      const player = new window.YT.Player(mountNode, {
        videoId: initial.videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            if (cancelled) return;
            playerRef.current = event.target;
            event.target.setVolume(volume);
            setPlayerReady(true);
            setYtAvailable(true);
            const dur = event.target.getDuration?.() ?? 0;
            if (dur > 0) setDuration(dur);
            applyAuthoritativeState(playbackRef.current);
          },
          onStateChange: (event) => {
            if (cancelled || !window.YT) return;
            const YTState = window.YT.PlayerState;
            if (event.data === YTState.PLAYING) {
              unexpectedPauseCountRef.current = 0;
              if (seekStartedAtMsRef.current !== null) {
                const measured = Date.now() - seekStartedAtMsRef.current;
                seekStartedAtMsRef.current = null;
                adaptiveSeekLatencyMsRef.current = updateAdaptiveSeekLatency(
                  adaptiveSeekLatencyMsRef.current,
                  measured,
                );
              }
              if (!audioUnlockedRef.current && !event.target.isMuted()) {
                audioUnlockedRef.current = true;
                setAudioUnlocked(true);
              }
              setNeedsGesture(false);
              const dur = event.target.getDuration?.() ?? 0;
              if (dur > 0) setDuration(dur);
            } else if (event.data === YTState.PAUSED) {
              // Auto-recover if browser/OS paused local iframe while room is playing
              if (
                playbackRef.current.status === 'playing' &&
                !scheduledStartTimerRef.current &&
                Date.now() - lastSeekRef.current > 1200
              ) {
                unexpectedPauseCountRef.current += 1;
                if (unexpectedPauseCountRef.current <= 2) {
                  const target =
                    computeTargetMediaTime(
                      playbackRef.current,
                      getServerNowRef.current(),
                    ) +
                    speakerOffsetRef.current / 1000;
                  performLatencyCompensatedSeek(event.target, target);
                  event.target.playVideo();
                } else {
                  setNeedsGesture(true);
                }
              }
            } else if (event.data === YTState.ENDED) {
              resetPlaybackRate(event.target);
              onTrackEnded(playbackRef.current.videoId);
            }
          },
          onError: () => {
            // Keep UI functional even if a video blocks embedding
          },
        },
      });

      playerRef.current = player;
    });

    return () => {
      cancelled = true;
      if (scheduledStartTimerRef.current) {
        window.clearTimeout(scheduledStartTimerRef.current);
      }
      if (bufferReadyTimerRef.current) {
        window.clearTimeout(bufferReadyTimerRef.current);
      }
      if (playerRef.current?.destroy) {
        try {
          playerRef.current.destroy();
        } catch {
          // Ignore destroy errors on unmount
        }
      }
      playerRef.current = null;
    };
  }, []);

  // Fallback buffer-ready signal when YouTube IFrame script is blocked or not yet ready
  useEffect(() => {
    if (playback.status !== 'buffering') return;
    if (ytAvailable && playerReady) return;
    const timer = window.setTimeout(() => {
      if (
        playbackRef.current.status === 'buffering' &&
        playbackRef.current.revision === playback.revision &&
        readyReportedRevisionRef.current !== playback.revision
      ) {
        readyReportedRevisionRef.current = playback.revision;
        onBufferReadyRef.current(playback.revision);
      }
    }, 240);
    return () => window.clearTimeout(timer);
  }, [playback.status, playback.revision, ytAvailable, playerReady]);

  // React to authoritative room state updates
  useEffect(() => {
    if (!playerReady || !playerRef.current) return;
    if (lastRevisionAppliedRef.current !== playback.revision) {
      lastRevisionAppliedRef.current = playback.revision;
      applyAuthoritativeState(playback);
    }
  }, [playback, playerReady]);

  // Wake recovery when switching back to tab or unlocking phone screen
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      onTriggerClockSync?.();
      const player = playerRef.current;
      const state = playbackRef.current;
      if (!player || !playerReady || state.status !== 'playing') return;

      window.setTimeout(() => {
        const p = playerRef.current;
        const s = playbackRef.current;
        if (!p || s.status !== 'playing') return;
        const target =
          computeTargetMediaTime(s, getServerNowRef.current()) +
          speakerOffsetRef.current / 1000;
        const actual = p.getCurrentTime?.() ?? target;
        if (Math.abs(actual - target) > 0.18) {
          performLatencyCompensatedSeek(p, target);
          p.playVideo();
        }
      }, 280);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [playerReady, onTriggerClockSync]);

  // Continuous 250ms two-tier drift monitoring & rate-nudge loop
  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentPlayback = playbackRef.current;
      const serverNow = getServerNowRef.current();
      const targetTime = computeTargetMediaTime(currentPlayback, serverNow);

      const player = playerRef.current;
      if (!player || !playerReady) {
        setDisplayTime(targetTime);
        currentDriftRef.current = 0;
        onDriftChange?.(0);
        return;
      }

      const dur = player.getDuration?.() ?? 0;
      if (dur > 0) setDuration(dur);

      const actualTime = player.getCurrentTime?.() ?? targetTime;
      setDisplayTime(currentPlayback.status === 'playing' ? actualTime : targetTime);

      if (currentPlayback.status === 'playing') {
        const pState = player.getPlayerState?.();
        const YTState = window.YT?.PlayerState;
        if (!YTState) return;

        // Never correct while YouTube is actively buffering; let buffer finish first
        if (pState === YTState.BUFFERING) {
          return;
        }

        // Detect if browser autoplay blocked playback
        if (
          (pState === YTState.UNSTARTED || pState === YTState.CUED || pState === YTState.PAUSED) &&
          serverNow - currentPlayback.anchorServerTime > 900 &&
          !scheduledStartTimerRef.current
        ) {
          setNeedsGesture(true);
          return;
        }

        if (pState === YTState.PLAYING) {
          setNeedsGesture(false);
          const availableRates = player.getAvailablePlaybackRates?.() ?? [1];
          const supportsRateNudge =
            availableRates.includes(0.75) && availableRates.includes(1.25);

          const decision = decideSyncCorrection({
            actualMediaTime: actualTime,
            targetMediaTime: targetTime,
            speakerOffsetMs: speakerOffsetRef.current,
            nowMs: Date.now(),
            lastSeekMs: lastSeekRef.current,
            supportsRateNudge,
            adaptiveSeekLatencyMs: adaptiveSeekLatencyMsRef.current,
          });
          currentDriftRef.current = decision.driftMs;
          onDriftChange?.(decision.driftMs);

          if (decision.action === 'in_sync') {
            resetPlaybackRate(player);
          } else if (decision.action === 'rate_nudge') {
            if (activeRateNudgeRef.current !== decision.rate && player.setPlaybackRate) {
              player.setPlaybackRate(decision.rate);
              activeRateNudgeRef.current = decision.rate;
            }
          } else if (decision.action === 'seek') {
            resetPlaybackRate(player);
            seekStartedAtMsRef.current = Date.now();
            lastSeekRef.current = Date.now();
            player.seekTo(decision.seekToTime, true);
          }
        }
      } else {
        resetPlaybackRate(player);
        currentDriftRef.current = 0;
        onDriftChange?.(0);
      }
    }, 250);

    return () => window.clearInterval(interval);
  }, [playerReady, onDriftChange]);

  // Send telemetry every 2.5s so connected devices list shows live RTT and drift
  useEffect(() => {
    const timer = window.setInterval(() => {
      onTelemetry(currentDriftRef.current, audioUnlockedRef.current);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [onTelemetry]);

  const unlockAudioAndSync = () => {
    audioUnlockedRef.current = true;
    setAudioUnlocked(true);
    setNeedsGesture(false);
    unexpectedPauseCountRef.current = 0;
    onTriggerClockSync?.();
    const player = playerRef.current;
    if (player && playerReady) {
      player.unMute();
      setMuted(false);
      player.setVolume(volume);
      const target = computeTargetMediaTime(playback, getServerNow()) + speakerOffsetMs / 1000;
      performLatencyCompensatedSeek(player, target);
      if (playback.status === 'playing') {
        player.playVideo();
      }
    }
    onTelemetry(currentDriftRef.current, true);
  };

  const handleTogglePlay = () => {
    if (!canControl) return;
    audioUnlockedRef.current = true;
    setAudioUnlocked(true);
    const current = playerRef.current?.getCurrentTime?.() ?? displayTime;
    if (playback.status === 'playing') {
      onPause(current);
    } else {
      onPlay(current);
    }
  };

  const handleSkip = (deltaSec: number) => {
    if (!canControl) return;
    const base = playerRef.current?.getCurrentTime?.() ?? displayTime;
    const next = Math.max(0, base + deltaSec);
    onSeek(next);
  };

  const handleResyncSelf = () => {
    unlockAudioAndSync();
  };

  const handleResyncAll = () => {
    onTriggerClockSync?.();
    if (!canControl) {
      handleResyncSelf();
      return;
    }
    const target = computeTargetMediaTime(playback, getServerNow());
    onResyncAll(target);
  };

  const handleVolumeChange = (nextVol: number) => {
    setVolume(nextVol);
    const player = playerRef.current;
    if (player && playerReady) {
      player.setVolume(nextVol);
      if (nextVol === 0) {
        player.mute();
        setMuted(true);
      } else if (muted) {
        player.unMute();
        setMuted(false);
      }
    }
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    const player = playerRef.current;
    if (player && playerReady) {
      if (nextMuted) player.mute();
      else {
        player.unMute();
        player.setVolume(volume || 80);
      }
    }
  };

  const effectiveTime = isScrubbing ? scrubValue : displayTime;
  const maxDuration = duration > 0 ? duration : Math.max(effectiveTime + 30, 240);

  return (
    <section
      id="player-stage"
      aria-label="Synchronized YouTube Player"
      className="rounded-2xl border border-white/10 bg-[#161A23] overflow-hidden"
    >
      {/* 16:9 YouTube Video Stage */}
      <div className="relative aspect-video w-full bg-[#090B0F]">
        <div
          ref={hostContainerRef}
          data-testid="youtube-player-frame"
          className="h-full w-full"
        />

        {/* Interaction guard: clicking video canvas toggles synchronized room Play/Pause instead of local desync */}
        {ytAvailable && playerReady && !needsGesture && (
          <button
            type="button"
            onClick={canControl ? handleTogglePlay : handleResyncSelf}
            aria-label={
              canControl
                ? playback.status === 'playing'
                  ? t(lang, 'pause')
                  : t(lang, 'play')
                : t(lang, 'resyncSelf')
            }
            className="absolute inset-0 z-10 bg-transparent cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#EF4444]"
          />
        )}

        {/* Fallback artwork stage when YouTube IFrame script cannot load */}
        {!ytAvailable && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0D1017] p-6 text-center">
            <SafeThumb
              src={playback.thumbnail}
              alt={playback.title}
              className="h-36 w-64 rounded-xl object-cover border border-white/10"
            />
            <p className="mt-4 font-display text-base font-semibold text-white max-w-md line-clamp-1">
              {playback.title}
            </p>
            <p className="mt-1 text-xs text-[#9CA3AF]">
              {playback.author} · {formatTime(effectiveTime)}
            </p>
          </div>
        )}

        {/* Pre-Buffer Handshake Overlay when syncing multiple devices before start */}
        {playback.status === 'buffering' && (
          <div
            role="status"
            data-testid="prebuffer-overlay"
            className="absolute inset-x-3 bottom-3 z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/15 bg-[#0B0D11]/90 backdrop-blur-md px-3.5 py-2.5 text-xs shadow-xl"
          >
            <div className="flex items-center gap-2 text-[#FCD34D]">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              <span className="font-medium">{t(lang, 'bufferingSyncStatus')}</span>
              <span className="font-mono-tabular text-[#D1D5DB]">
                ({playback.readyClientIds?.length ?? 0}/{Math.max(1, participantCount)}{' '}
                {t(lang, 'bufferingDevicesReady')})
              </span>
            </div>
            {canControl && (
              <button
                type="button"
                onClick={onForceStart}
                className="min-h-[30px] px-2.5 rounded-lg bg-[#EF4444] text-white text-xs font-semibold hover:bg-[#DC2626] transition-colors whitespace-nowrap cursor-pointer"
              >
                {t(lang, 'forceStartNow')}
              </button>
            )}
          </div>
        )}

        {/* Audio / Autoplay Unlock Overlay for guest devices */}
        {needsGesture && playback.status === 'playing' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/75 backdrop-blur-sm p-6 text-center">
            <button
              type="button"
              onClick={unlockAudioAndSync}
              className="min-h-[48px] px-6 py-3 rounded-xl bg-[#EF4444] text-white font-semibold text-sm sm:text-base hover:bg-[#DC2626] transition-colors shadow-lg cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              {t(lang, 'tapToUnlockAudio')}
            </button>
            <p className="mt-3 max-w-sm text-xs sm:text-sm text-[#D1D5DB]">
              {t(lang, 'tapToUnlockDesc')}
            </p>
          </div>
        )}
      </div>

      {/* Track Title + Synchronized Transport Controls */}
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-display text-lg sm:text-xl font-semibold text-white truncate">
              {playback.title}
            </h1>
            <p className="text-xs sm:text-sm text-[#9CA3AF] truncate">
              {playback.author}
              <span aria-hidden="true"> · </span>
              <span className="font-mono-tabular">{playback.videoId}</span>
            </p>
          </div>
          {!canControl && (
            <p className="text-xs text-[#D97706] shrink-0">
              {t(lang, 'hostOnlyNotice')}
            </p>
          )}
        </div>

        {/* Scrubber */}
        <div className="space-y-1.5">
          <input
            type="range"
            min={0}
            max={maxDuration}
            step={0.5}
            value={Math.min(effectiveTime, maxDuration)}
            disabled={!canControl}
            aria-label="Seek timeline"
            onChange={(e) => {
              setIsScrubbing(true);
              setScrubValue(Number(e.target.value));
            }}
            onMouseUp={() => {
              if (isScrubbing) {
                setIsScrubbing(false);
                onSeek(scrubValue);
              }
            }}
            onTouchEnd={() => {
              if (isScrubbing) {
                setIsScrubbing(false);
                onSeek(scrubValue);
              }
            }}
            className="studio-range w-full disabled:opacity-50"
          />
          <div className="flex items-center justify-between text-xs font-mono-tabular text-[#9CA3AF]">
            <span>{formatTime(effectiveTime)}</span>
            <span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
          </div>
        </div>

        {/* Transport Buttons Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleSkip(-10)}
              disabled={!canControl}
              aria-label={t(lang, 'skipBack')}
              title={t(lang, 'skipBack')}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-white/10 bg-[#0B0D11] text-[#D1D5DB] hover:text-white hover:border-white/25 disabled:opacity-40 transition-colors cursor-pointer"
            >
              <RotateCcw className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={handleTogglePlay}
              disabled={!canControl}
              aria-label={playback.status === 'playing' ? t(lang, 'pause') : t(lang, 'play')}
              className="min-h-[44px] px-5 rounded-xl bg-[#EF4444] text-white font-semibold text-sm hover:bg-[#DC2626] disabled:opacity-40 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {playback.status === 'playing' ? (
                <>
                  <Pause className="h-4 w-4" />
                  <span>{t(lang, 'pause')}</span>
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  <span>{t(lang, 'play')}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleSkip(10)}
              disabled={!canControl}
              aria-label={t(lang, 'skipForward')}
              title={t(lang, 'skipForward')}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-white/10 bg-[#0B0D11] text-[#D1D5DB] hover:text-white hover:border-white/25 disabled:opacity-40 transition-colors cursor-pointer"
            >
              <RotateCw className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={canControl ? handleResyncAll : handleResyncSelf}
              className="min-h-[44px] px-3.5 rounded-xl border border-white/10 bg-[#0B0D11] text-xs sm:text-sm font-medium text-[#E5E7EB] hover:bg-white/5 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{canControl ? t(lang, 'resyncAll') : t(lang, 'resyncSelf')}</span>
            </button>
          </div>

          {/* Volume & Speaker Offset Toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-white/10 bg-[#0B0D11] text-[#D1D5DB] hover:text-white transition-colors cursor-pointer"
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volume}
              aria-label={t(lang, 'volume')}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="studio-range w-24 hidden sm:block"
            />
            <button
              type="button"
              onClick={() => wakeLock.setWakeLockEnabled((v) => !v)}
              aria-pressed={wakeLock.wakeLockEnabled}
              aria-label={t(lang, 'wakeLockLabel')}
              title={wakeLock.isActive ? t(lang, 'wakeLockActive') : t(lang, 'wakeLockLabel')}
              data-testid="wake-lock-toggle"
              className={`min-h-[44px] px-3 rounded-xl border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                wakeLock.wakeLockEnabled
                  ? 'border-[#16A34A]/50 bg-[#16A34A]/10 text-[#4ADE80]'
                  : 'border-white/10 bg-[#0B0D11] text-[#9CA3AF] hover:text-white'
              }`}
            >
              <Sun className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t(lang, 'wakeLockLabel')}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowOffsetSlider((v) => !v)}
              aria-expanded={showOffsetSlider}
              aria-label={t(lang, 'speakerOffset')}
              className={`min-h-[44px] px-3 rounded-xl border text-xs font-mono-tabular flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                showOffsetSlider || speakerOffsetMs !== 0
                  ? 'border-[#EF4444]/60 bg-[#EF4444]/10 text-white'
                  : 'border-white/10 bg-[#0B0D11] text-[#9CA3AF] hover:text-white'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>{speakerOffsetMs >= 0 ? `+${speakerOffsetMs}ms` : `${speakerOffsetMs}ms`}</span>
            </button>
          </div>
        </div>

        {/* Speaker / Bluetooth Delay Calibration Drawer */}
        {showOffsetSlider && (
          <div className="rounded-xl border border-white/10 bg-[#0B0D11] p-4 space-y-2">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="speaker-offset-range" className="text-xs sm:text-sm font-medium text-white">
                {t(lang, 'speakerOffset')}
              </label>
              <span className="font-mono-tabular text-xs text-[#EF4444]">
                {speakerOffsetMs >= 0 ? `+${speakerOffsetMs} ms` : `${speakerOffsetMs} ms`}
              </span>
            </div>
            <input
              id="speaker-offset-range"
              type="range"
              min={-400}
              max={400}
              step={20}
              value={speakerOffsetMs}
              onChange={(e) => setSpeakerOffsetMs(Number(e.target.value))}
              className="studio-range w-full"
            />
            <p className="text-xs text-[#9CA3AF]">{t(lang, 'speakerOffsetHelp')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
