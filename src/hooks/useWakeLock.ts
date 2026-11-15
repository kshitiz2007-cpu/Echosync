import { useCallback, useEffect, useRef, useState } from 'react';

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
}

/**
 * Keeps mobile/tablet screens awake while synchronized playback is active
 * and automatically re-acquires the lock when returning to the app tab.
 */
export function useWakeLock(shouldKeepAwake: boolean) {
  const isSupported =
    typeof navigator !== 'undefined' &&
    Boolean((navigator as unknown as NavigatorWithWakeLock).wakeLock?.request);

  const [enabled, setEnabled] = useState<boolean>(true);
  const [isActive, setIsActive] = useState<boolean>(false);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  const releaseLock = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setIsActive(false);
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // Ignore release errors when document is unloading/hidden
      }
    }
  }, []);

  const requestLock = useCallback(async () => {
    if (!isSupported || !enabled || !shouldKeepAwake) {
      await releaseLock();
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }
    if (sentinelRef.current && !sentinelRef.current.released) {
      setIsActive(true);
      return;
    }
    try {
      const nav = navigator as unknown as NavigatorWithWakeLock;
      const sentinel = await nav.wakeLock!.request('screen');
      sentinelRef.current = sentinel;
      setIsActive(true);
      sentinel.addEventListener?.('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
          setIsActive(false);
        }
      });
    } catch {
      // Battery saver mode or browser policy may temporarily deny Wake Lock
      setIsActive(false);
    }
  }, [isSupported, enabled, shouldKeepAwake, releaseLock]);

  useEffect(() => {
    if (enabled && shouldKeepAwake) {
      void requestLock();
    } else {
      void releaseLock();
    }
  }, [enabled, shouldKeepAwake, requestLock, releaseLock]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && enabled && shouldKeepAwake) {
        void requestLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      void releaseLock();
    };
  }, [enabled, shouldKeepAwake, requestLock, releaseLock]);

  return {
    isSupported,
    isActive,
    wakeLockEnabled: enabled,
    setWakeLockEnabled: setEnabled,
  };
}
