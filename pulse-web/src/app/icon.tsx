/**
 * Dynamic favicon: Σ glyph on indigo gradient.
 * Next.js App Router автоматически использует этот файл как /favicon.
 * Заменяет статический favicon.ico — теперь всегда фирменная иконка Σ.
 */
import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)',
          color: 'white',
          fontWeight: 700,
          fontSize: 26,
          lineHeight: 1,
          fontFamily: 'serif',
          borderRadius: 6,
        }}
      >
        Σ
      </div>
    ),
    size,
  );
}
