import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import type { Language } from '../shared/types';
import { t } from '../i18n/translations';

export function OfflineBanner({ lang }: { lang: Language }) {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl border border-[#D97706]/50 bg-[#161A23] px-3.5 py-2 text-xs font-medium text-[#FCD34D] shadow-xl"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>{t(lang, 'offlineNotice')}</span>
    </div>
  );
}
