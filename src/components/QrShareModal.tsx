import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Download, ExternalLink, X } from 'lucide-react';
import type { Language } from '../shared/types';
import { t } from '../i18n/translations';

interface QrShareModalProps {
  open: boolean;
  roomCode: string;
  inviteUrl: string;
  isPrivatePreview?: boolean;
  publicAppUrl?: string;
  lang: Language;
  onClose: () => void;
}

export function QrShareModal({
  open,
  roomCode,
  inviteUrl,
  isPrivatePreview = false,
  publicAppUrl = '',
  lang,
  onClose,
}: QrShareModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    QRCode.toDataURL(inviteUrl, {
      width: 240,
      margin: 2,
      color: {
        dark: '#0B0D11',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [open, inviteUrl]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback ignored
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#161A23] p-6 text-[#F3F4F6] shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="qr-modal-title" className="font-display text-lg font-semibold">
              {t(lang, 'qrModalTitle')}
            </h2>
            <p className="mt-1 text-sm text-[#9CA3AF]">{t(lang, 'qrModalDesc')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(lang, 'close')}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-white/10 text-[#9CA3AF] hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isPrivatePreview && publicAppUrl && (
          <div className="mt-4 rounded-xl border border-[#D97706]/50 bg-[#0B0D11] p-3.5 space-y-2.5">
            <p className="text-xs text-[#FCD34D] leading-relaxed">
              {lang === 'hi'
                ? 'चेतावनी: आप प्राइवेट Preview (`ais-dev`) पर हैं — बाहरी फ़ोन इस लिंक को खोलने पर Page Not Found दिखाएंगे। मल्टी-डिवाइस सिंक के लिए Public App पर रूम बनाएं:'
                : 'Notice: You are on private Preview (`ais-dev`). External phones scanning this URL will see Page Not Found. Open the Public App to sync across devices:'}
            </p>
            <a
              href={publicAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[#D97706] px-3 py-1.5 text-xs font-semibold text-black hover:bg-[#F59E0B] transition-colors"
            >
              <span>{lang === 'hi' ? 'Public App खोलें' : 'Open Public App'}</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        <div className="mt-5 flex flex-col items-center">
          <div className="rounded-xl bg-white p-3">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`Room ${roomCode} QR Code`}
                className="h-52 w-52 object-contain"
              />
            ) : (
              <div className="flex h-52 w-52 items-center justify-center text-sm text-slate-700 font-mono-tabular">
                {roomCode}
              </div>
            )}
          </div>
          <div className="mt-4 text-center">
            <span className="text-xs text-[#9CA3AF]">{t(lang, 'roomCodeTag')}</span>
            <p className="font-mono-tabular text-2xl font-bold tracking-[0.22em] text-white mt-0.5">
              {roomCode}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={inviteUrl}
            aria-label="Invite URL"
            className="w-full min-h-[44px] rounded-lg border border-white/10 bg-[#0B0D11] px-3 text-xs font-mono-tabular text-[#D1D5DB] focus:outline-none"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="min-h-[44px] px-4 rounded-lg bg-[#EF4444] text-white text-sm font-medium hover:bg-[#DC2626] transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? t(lang, 'copiedLink') : t(lang, 'copyLink')}
          </button>
        </div>

        {qrDataUrl && (
          <div className="mt-3 flex justify-center">
            <a
              href={qrDataUrl}
              download={`echosync-room-${roomCode}.png`}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-white/10 bg-[#0B0D11] px-3.5 text-xs font-medium text-[#D1D5DB] hover:text-white hover:border-white/25 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{t(lang, 'downloadQr')}</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
