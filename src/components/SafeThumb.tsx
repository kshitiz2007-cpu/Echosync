import { useState } from 'react';
import { Music } from 'lucide-react';

interface SafeThumbProps {
  src: string;
  alt: string;
  className?: string;
}

export function SafeThumb({ src, alt, className = '' }: SafeThumbProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex items-center justify-center bg-gradient-to-br from-[#1E2430] to-[#0F1218] text-[#9CA3AF] ${className}`}
      >
        <Music className="h-5 w-5 opacity-70" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
