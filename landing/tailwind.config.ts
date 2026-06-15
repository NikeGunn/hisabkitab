import type { Config } from 'tailwindcss';

/**
 * Palette and scale: warm orange and cream, white surface, deliberate spacing,
 * card/control/pill radii. Typography blends mono labels with an editorial serif
 * display (see globals.css for the font stacks).
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#F68B1F',
        accent: '#FDB813',
        cream: '#F2EAD3',
        surface: '#FFFFFF',
        ink: '#111827',
        muted: '#4B5563',
        hairline: '#E5E7EB',
        // WhatsApp chat tones (for the device mockup)
        wa: {
          bg: '#E7DECB',
          out: '#DCF8C6',
          in: '#FFFFFF',
          header: '#075E54',
          tick: '#34B7F1',
        },
      },
      fontFamily: {
        // editorial serif for display moments
        serif: ['var(--font-serif)', 'Georgia', 'Times New Roman', 'serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: '16px',
        control: '8px',
        pill: '9999px',
      },
      maxWidth: { content: '1200px' },
      boxShadow: {
        card: '0 1px 2px rgba(17,24,39,0.04), 0 8px 24px rgba(17,24,39,0.06)',
        lift: '0 12px 40px rgba(246,139,31,0.18)',
        device: '0 30px 80px -20px rgba(17,24,39,0.35)',
      },
      keyframes: {
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        marqueeReverse: {
          '0%': { transform: 'translateX(-50%)' },
          '100%': { transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        marquee: 'marquee 40s linear infinite',
        'marquee-reverse': 'marqueeReverse 40s linear infinite',
        shimmer: 'shimmer 2.5s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
