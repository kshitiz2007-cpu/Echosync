import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ExternalLink, Laptop, Play, Radio, Smartphone, Users } from 'lucide-react';
import {
  CURATED_TRACKS,
  extractRoomCodeFromInput,
  normalizeRoomCode,
  parseYouTubeId,
} from '../shared/syncMath';
import type { Language } from '../shared/types';
import { t } from '../i18n/translations';
import { SafeThumb } from './SafeThumb';

interface LobbyViewProps {
  lang: Language;
  onChangeLang: (lang: Language) => void;
  prefilledRoomCode: string;
  externalError: string | null;
  isConnecting: boolean;
  onCreateRoom: (params: {
    name: string;
    initialVideoId?: string;
    initialTrack?: { title: string; author: string; thumbnail: string };
  }) => void;
  onJoinRoom: (params: { roomCode: string; name: string }) => void;
}

export function LobbyView({
  lang,
  onChangeLang,
  prefilledRoomCode,
  externalError,
  isConnecting,
  onCreateRoom,
  onJoinRoom,
}: LobbyViewProps) {
  const [hostName, setHostName] = useState('');
  const [youtubeInput, setYoutubeInput] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinName, setJoinName] = useState('');
  const [roomCode, setRoomCode] = useState(prefilledRoomCode);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    if (prefilledRoomCode) {
      setRoomCode(prefilledRoomCode);
    }
  }, [prefilledRoomCode]);

  const isPrivatePreview =
    typeof window !== 'undefined' && window.location.hostname.startsWith('ais-dev-');
  const publicShareUrl =
    isPrivatePreview && typeof window !== 'undefined'
      ? window.location.origin.replace('://ais-dev-', '://ais-pre-')
      : '';

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    const trimmedName = hostName.trim();
    if (!trimmedName) {
      setCreateError(t(lang, 'errorNameRequired'));
      return;
    }

    const trimmedUrl = youtubeInput.trim();
    let parsedId: string | undefined;
    if (trimmedUrl) {
      const id = parseYouTubeId(trimmedUrl);
      if (!id) {
        setCreateError(t(lang, 'errorInvalidYoutube'));
        return;
      }
      parsedId = id;
    }

    onCreateRoom({ name: trimmedName, initialVideoId: parsedId });
  };

  const handleJoinSubmit = (e: FormEvent) => {
    e.preventDefault();
    setJoinError(null);
    const trimmedName = joinName.trim();
    const code = normalizeRoomCode(roomCode);

    if (!trimmedName) {
      setJoinError(t(lang, 'errorNameRequired'));
      return;
    }
    if (code.length !== 6) {
      setJoinError(t(lang, 'errorRoomCodeLength'));
      return;
    }
    onJoinRoom({ roomCode: code, name: trimmedName });
  };

  const handleQuickLaunch = (track: (typeof CURATED_TRACKS)[number]) => {
    const cleanName = hostName.trim() || (lang === 'hi' ? 'मुख्य डिवाइस' : 'Host Device');
    onCreateRoom({
      name: cleanName,
      initialVideoId: track.videoId,
      initialTrack: {
        title: track.title,
        author: track.author,
        thumbnail: track.thumbnail,
      },
    });
  };

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 sm:py-12 space-y-14">
      {/* Workspace Toolbar: Language Switcher */}
      <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-4">
        <p className="text-xs sm:text-sm text-[#9CA3AF]">
          WebSocket + NTP Clock Sync
          <span aria-hidden="true"> · </span>
          YouTube IFrame API
        </p>
        <div
          role="group"
          aria-label={t(lang, 'languageLabel')}
          className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#161A23] p-1"
        >
          <button
            type="button"
            onClick={() => onChangeLang('hi')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              lang === 'hi'
                ? 'bg-[#EF4444] text-white'
                : 'text-[#9CA3AF] hover:text-white'
            }`}
          >
            हिंदी
          </button>
          <button
            type="button"
            onClick={() => onChangeLang('en')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              lang === 'en'
                ? 'bg-[#EF4444] text-white'
                : 'text-[#9CA3AF] hover:text-white'
            }`}
          >
            English
          </button>
        </div>
      </div>

      {/* Hero + Create / Join Room Split */}
      <section
        id="lobby-forms"
        className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-start"
      >
        {/* Left Editorial Hero */}
        <div className="lg:col-span-6 space-y-6">
          <h1
            className="font-display text-3xl sm:text-5xl font-bold tracking-tight text-white leading-[1.12]"
            style={{ textWrap: 'balance' }}
          >
            {t(lang, 'heroTitle')}
          </h1>
          <p className="text-base sm:text-lg text-[#9CA3AF] leading-relaxed max-w-xl">
            {t(lang, 'heroSubtitle')}
          </p>

          {/* If invited via URL (?room=XXXXXX), highlight Join Banner cleanly */}
          {prefilledRoomCode && (
            <div className="rounded-2xl border border-[#EF4444]/40 bg-[#161A23] p-5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">
                  {t(lang, 'joiningRoomTitle')}
                </span>
                <span className="font-mono-tabular text-base font-bold tracking-widest text-[#EF4444]">
                  {prefilledRoomCode}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-[#9CA3AF]">
                {t(lang, 'joiningRoomSubtitle')}
              </p>
            </div>
          )}

          {/* Join Existing Room Card */}
          <form
            onSubmit={handleJoinSubmit}
            className="rounded-2xl border border-white/10 bg-[#161A23] p-6 space-y-4"
          >
            <div className="flex items-center gap-2.5">
              <Users className="h-5 w-5 text-[#EF4444]" />
              <h2 className="font-display text-lg font-semibold text-white">
                {t(lang, 'joinRoomHeading')}
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="join-room-code"
                  className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
                >
                  {t(lang, 'roomCodeLabel')}
                </label>
                <input
                  id="join-room-code"
                  type="text"
                  value={roomCode}
                  onChange={(e) => setRoomCode(extractRoomCodeFromInput(e.target.value))}
                  placeholder={t(lang, 'roomCodePlaceholder')}
                  className="w-full min-h-[44px] rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 text-sm font-mono-tabular tracking-widest text-white placeholder:text-[#6B7280] focus:border-[#EF4444] focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="join-user-name"
                  className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
                >
                  {t(lang, 'yourNameLabel')}
                </label>
                <input
                  id="join-user-name"
                  type="text"
                  maxLength={32}
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  placeholder={t(lang, 'yourNamePlaceholder')}
                  className="w-full min-h-[44px] rounded-xl border border-white/10 bg-[#0B0D11] px-3.5 text-sm text-white placeholder:text-[#6B7280] focus:border-[#EF4444] focus:outline-none"
                />
              </div>
            </div>

            {(joinError || externalError) && (
              <p role="alert" className="text-xs sm:text-sm text-[#F87171]">
                {joinError ||
                  (externalError === 'ROOM_NOT_FOUND'
                    ? t(lang, 'roomNotFound')
                    : externalError)}
              </p>
            )}

            <button
              type="submit"
              disabled={isConnecting}
              className="w-full min-h-[44px] rounded-xl border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>{t(lang, 'joinRoomButton')}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          {isPrivatePreview && publicShareUrl && (
            <div className="rounded-2xl border border-[#D97706]/40 bg-[#161A23] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-xs text-[#E5E7EB] leading-relaxed">
                {lang === 'hi'
                  ? 'दूसरे फ़ोन/डिवाइस को QR या कोड से जोड़ने के लिए Public App लिंक पर रूम बनाएं (Preview लिंक केवल आपके ब्राउज़र के लिए है):'
                  : 'To join from other phones via QR or room code, open the Public App link on both devices (Preview is private to your browser):'}
              </p>
              <a
                href={publicShareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-h-[38px] px-3.5 rounded-lg bg-[#D97706] text-black text-xs font-semibold hover:bg-[#F59E0B] transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <span>{lang === 'hi' ? 'Public App खोलें' : 'Open Public App'}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}
        </div>

        {/* Right Primary Studio Action: Create Room */}
        <div className="lg:col-span-6 space-y-6">
          <form
            id="create-room-form"
            onSubmit={handleCreateSubmit}
            className="rounded-2xl border border-white/10 bg-[#161A23] p-6 sm:p-8 space-y-5"
          >
            <div className="flex items-center gap-2.5">
              <Radio className="h-5 w-5 text-[#EF4444]" />
              <h2 className="font-display text-xl font-semibold text-white">
                {t(lang, 'createRoomHeading')}
              </h2>
            </div>

            <div>
              <label
                htmlFor="host-user-name"
                className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
              >
                {t(lang, 'yourNameLabel')}
              </label>
              <input
                id="host-user-name"
                type="text"
                maxLength={32}
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                placeholder={t(lang, 'yourNamePlaceholder')}
                className="w-full min-h-[46px] rounded-xl border border-white/10 bg-[#0B0D11] px-4 text-sm text-white placeholder:text-[#6B7280] focus:border-[#EF4444] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="initial-youtube-url"
                className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
              >
                {t(lang, 'optionalUrlLabel')}
              </label>
              <input
                id="initial-youtube-url"
                type="text"
                value={youtubeInput}
                onChange={(e) => setYoutubeInput(e.target.value)}
                placeholder={t(lang, 'optionalUrlPlaceholder')}
                className="w-full min-h-[46px] rounded-xl border border-white/10 bg-[#0B0D11] px-4 text-sm text-white placeholder:text-[#6B7280] focus:border-[#EF4444] focus:outline-none"
              />
            </div>

            {createError && (
              <p role="alert" className="text-xs sm:text-sm text-[#F87171]">
                {createError}
              </p>
            )}

            <button
              type="submit"
              disabled={isConnecting}
              className="w-full min-h-[48px] rounded-xl bg-[#EF4444] px-6 py-3 text-sm sm:text-base font-semibold text-white hover:bg-[#DC2626] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <Play className="h-4 w-4" />
              <span>{t(lang, 'createRoomButton')}</span>
            </button>
          </form>

          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl border border-white/10 bg-[#161A23] p-4 flex items-start gap-3">
              <Smartphone className="h-5 w-5 text-[#EF4444] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-white">
                  {lang === 'hi' ? 'QR स्कैन से तुरंत जुड़ें' : 'Instant QR Phone Join'}
                </p>
                <p className="mt-1 text-xs text-[#9CA3AF]">
                  {lang === 'hi'
                    ? 'बिना लॉगिन के किसी भी मोबाइल या टैबलेट पर लिंक खोलें।'
                    : 'Scan from any phone camera with zero sign-up required.'}
                </p>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-[#161A23] p-4 flex items-start gap-3">
              <Laptop className="h-5 w-5 text-[#EF4444] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-white">
                  {lang === 'hi' ? 'स्पीकर डिले कैलिब्रेशन' : 'Speaker Offset Control'}
                </p>
                <p className="mt-1 text-xs text-[#9CA3AF]">
                  {lang === 'hi'
                    ? 'Bluetooth स्पीकर की देरी को ±400ms तक एडजस्ट करें।'
                    : 'Fine-tune Bluetooth speaker delay up to ±400ms per device.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Curated Quick-Start Tracks */}
      <section id="quick-tracks" className="space-y-4">
        <h2 className="font-display text-xl font-semibold text-white">
          {t(lang, 'curatedHeading')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {CURATED_TRACKS.map((track) => (
            <div
              key={track.videoId}
              className="flex flex-col justify-between rounded-2xl border border-white/10 bg-[#161A23] overflow-hidden"
            >
              <div className="aspect-video w-full bg-[#0B0D11] overflow-hidden">
                <SafeThumb
                  src={track.thumbnail}
                  alt={track.title}
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="p-4 flex flex-col justify-between flex-1 gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white line-clamp-2">
                    {track.title}
                  </h3>
                  <p className="mt-1 text-xs text-[#9CA3AF]">
                    {track.author}
                    <span aria-hidden="true"> · </span>
                    <span className="font-mono-tabular">{track.videoId}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleQuickLaunch(track)}
                  className="w-full min-h-[40px] rounded-lg border border-white/10 bg-[#0B0D11] px-3 py-2 text-xs font-medium text-[#E5E7EB] hover:bg-[#EF4444] hover:border-[#EF4444] hover:text-white transition-colors cursor-pointer whitespace-nowrap"
                >
                  {t(lang, 'curatedAction')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* How Multi-Device Sync Works */}
      <section
        id="how-sync-works"
        className="border-t border-white/10 pt-10 space-y-6"
      >
        <h2 className="font-display text-xl sm:text-2xl font-semibold text-white">
          {t(lang, 'howItWorksTitle')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-white/10 bg-[#161A23] p-6 space-y-2">
            <h3 className="font-display text-base font-semibold text-white">
              {t(lang, 'step1Title')}
            </h3>
            <p className="text-sm text-[#9CA3AF] leading-relaxed">
              {t(lang, 'step1Desc')}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#161A23] p-6 space-y-2">
            <h3 className="font-display text-base font-semibold text-white">
              {t(lang, 'step2Title')}
            </h3>
            <p className="text-sm text-[#9CA3AF] leading-relaxed">
              {t(lang, 'step2Desc')}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#161A23] p-6 space-y-2">
            <h3 className="font-display text-base font-semibold text-white">
              {t(lang, 'step3Title')}
            </h3>
            <p className="text-sm text-[#9CA3AF] leading-relaxed">
              {t(lang, 'step3Desc')}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
