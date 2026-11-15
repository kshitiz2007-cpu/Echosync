import { useEffect, useState } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import type { Language } from '../shared/types';
import { t } from '../i18n/translations';

interface PWAInstallButtonProps {
  lang: Language;
}

export function PWAInstallButton({ lang }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, isInIframe, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (!showGuide) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowGuide(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showGuide]);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      const accepted = await install();
      if (accepted) return;
    }
    setShowGuide(true);
  };

  const openTargetUrl =
    typeof window !== 'undefined'
      ? window.location.hostname.startsWith('ais-dev-')
        ? window.location.origin.replace('://ais-dev-', '://ais-pre-')
        : window.location.href
      : '/';

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        aria-label={t(lang, 'installApp')}
        title={t(lang, 'installApp')}
        data-testid="pwa-install-btn"
        className="min-h-[40px] px-2.5 sm:px-3 rounded-lg border border-white/15 bg-[#161A23] text-xs font-medium text-[#F3F4F6] hover:border-white/30 hover:bg-white/5 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EF4444]"
      >
        <Download className="h-3.5 w-3.5 text-[#EF4444] shrink-0" />
        <span className="hidden sm:inline">{t(lang, 'installApp')}</span>
      </button>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-guide-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowGuide(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#161A23] p-6 text-[#F3F4F6] shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h3 id="pwa-install-guide-title" className="font-display text-lg font-semibold">
                {isIOS ? t(lang, 'iosInstallTitle') : t(lang, 'installGuideTitle')}
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label={t(lang, 'close')}
                className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-white/10 text-[#9CA3AF] hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-[#D1D5DB] leading-relaxed">
              {isInIframe
                ? t(lang, 'installGuideIframe')
                : isIOS
                  ? t(lang, 'iosInstallSteps')
                  : t(lang, 'installGuideAndroidDesktop')}
            </p>

            {isInIframe && (
              <a
                href={openTargetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full min-h-[42px] rounded-xl bg-[#EF4444] text-sm font-semibold text-white hover:bg-[#DC2626] transition-colors inline-flex items-center justify-center gap-2"
              >
                <span>{t(lang, 'openInNewTab')}</span>
                <ExternalLink className="h-4 w-4" />
              </a>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full min-h-[42px] rounded-xl border border-white/10 bg-[#0B0D11] text-sm font-medium text-[#E5E7EB] hover:bg-white/5 transition-colors cursor-pointer"
            >
              {t(lang, 'close')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
