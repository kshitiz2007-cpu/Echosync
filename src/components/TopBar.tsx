import { getRttQuality, type NetworkConnectionState } from '../shared/syncMath';
import type { Language } from '../shared/types';
import { t } from '../i18n/translations';
import { PWAInstallButton } from './PWAInstallButton';

interface TopBarProps {
  lang: Language;
  inRoom: boolean;
  rttMs: number | null;
  networkStatus: NetworkConnectionState;
  onPrimaryAction: () => void;
  onNavigateSection: (sectionId: string) => void;
}

export function TopBar({
  lang,
  inRoom,
  rttMs,
  networkStatus,
  onPrimaryAction,
  onNavigateSection,
}: TopBarProps) {
  const quality = getRttQuality(rttMs, networkStatus);

  const dotStyles =
    quality === 'good'
      ? {
          ring: 'bg-[#22C55E]/60',
          dot: 'bg-[#22C55E]',
          text: 'text-[#22C55E]',
          label: t(lang, 'rttQualityGood'),
        }
      : quality === 'fair'
        ? {
            ring: 'bg-[#EAB308]/60',
            dot: 'bg-[#EAB308]',
            text: 'text-[#EAB308]',
            label:
              networkStatus === 'connecting' || rttMs === null
                ? t(lang, 'rttChecking')
                : t(lang, 'rttQualityFair'),
          }
        : {
            ring: 'bg-[#EF4444]/60',
            dot: 'bg-[#EF4444]',
            text: 'text-[#EF4444]',
            label: t(lang, 'rttQualityPoor'),
          };

  const rttDisplay = rttMs !== null && Number.isFinite(rttMs) ? `${Math.round(rttMs)}ms` : '--';
  const ariaStatus = `${t(lang, 'networkHealthLabel')}: ${dotStyles.label} (${rttDisplay})`;

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0B0D11]/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 sm:gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Single-line Brand Wordmark */}
        <a
          href="/"
          className="font-display text-lg font-bold tracking-tight text-[#F3F4F6] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EF4444] rounded-sm"
        >
          {t(lang, 'brand')}
        </a>

        {/* Zone 2: Concise single-line navigation links */}
        <nav
          aria-label="Primary"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-[#9CA3AF]"
        >
          {inRoom ? (
            <>
              <button
                type="button"
                onClick={() => onNavigateSection('player-stage')}
                className="hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t(lang, 'navPlayer')}
              </button>
              <button
                type="button"
                onClick={() => onNavigateSection('track-loader')}
                className="hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t(lang, 'addToQueue')}
              </button>
              <button
                type="button"
                onClick={() => onNavigateSection('room-sidebar')}
                className="hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t(lang, 'devicesTab')}
              </button>
              <button
                type="button"
                onClick={() => onNavigateSection('room-sidebar')}
                className="hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t(lang, 'queueTab')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onNavigateSection('lobby-forms')}
                className="hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t(lang, 'joinRoomButton')}
              </button>
              <button
                type="button"
                onClick={() => onNavigateSection('how-sync-works')}
                className="hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t(lang, 'navHowItWorks')}
              </button>
              <button
                type="button"
                onClick={() => onNavigateSection('quick-tracks')}
                className="hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t(lang, 'navTracks')}
              </button>
            </>
          )}
        </nav>

        {/* Zone 3: Network RTT Sync Indicator + Primary CTA */}
        <div className="flex items-center gap-3 sm:gap-4 shrink-0">
          <div
            role="status"
            aria-label={ariaStatus}
            title={ariaStatus}
            data-testid="topbar-sync-indicator"
            data-rtt-quality={quality}
            className="flex items-center gap-2 text-xs whitespace-nowrap shrink-0"
          >
            <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden="true">
              <span
                className={`absolute inline-flex h-2 w-2 rounded-full animate-rtt-pulse ${dotStyles.ring}`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-300 ${dotStyles.dot}`}
              />
            </span>
            <span className={`hidden sm:inline font-medium transition-colors duration-300 ${dotStyles.text}`}>
              {dotStyles.label}
            </span>
            <span className="font-mono-tabular text-[#9CA3AF]">
              {rttDisplay}
            </span>
          </div>

          <div className="h-4 w-px bg-white/10" aria-hidden="true" />

          <PWAInstallButton lang={lang} />

          <button
            type="button"
            onClick={onPrimaryAction}
            className="min-h-[40px] px-4 py-2 text-sm font-semibold rounded-lg bg-[#EF4444] text-white hover:bg-[#DC2626] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            {inRoom ? t(lang, 'ctaLeaveRoom') : t(lang, 'ctaCreateQuick')}
          </button>
        </div>
      </div>
    </header>
  );
}
