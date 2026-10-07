import type { ChannelRef } from '@tvspy/shared';
import { useState } from 'react';

/** Channel logo from TVHeadend (through tvspy's cache), or the channel's initials when there is none. */
export function ChannelLogo({ channel, size = 32 }: { channel: ChannelRef; size?: number }) {
  const [failed, setFailed] = useState(false);
  const words = channel.name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean);
  const initials = (
    words.length === 1
      ? (words[0] as string).slice(0, 3)
      : words
          .slice(0, 2)
          .map((w) => w[0])
          .join('')
  ).toUpperCase();
  const box =
    'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-white';
  if (!channel.id || failed) {
    return (
      <span
        aria-hidden
        className={`${box} text-[10px] font-semibold text-[#52514e]`}
        style={{ width: size * 1.5, height: size }}
      >
        {initials || 'TV'}
      </span>
    );
  }
  return (
    <span className={box} style={{ width: size * 1.5, height: size }}>
      <img
        src={`/api/channels/${channel.id}/icon`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-full max-w-full object-contain p-0.5"
      />
    </span>
  );
}
