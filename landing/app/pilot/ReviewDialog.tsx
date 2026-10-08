'use client';

import { useEffect, useRef } from 'react';

/**
 * Shown after a pilot application is received. Nothing has been sent to the
 * applicant's WhatsApp yet: our team reviews every business by hand first, then
 * HisabKitab messages them and their reply starts the trial.
 */
export interface ReviewDialogProps {
  ownerName: string;
  businessName: string;
  resubmitted: boolean;
  senderE164?: string;
  waLink?: string;
  onClose: () => void;
}

type Step = { title: string; body: string; state: 'done' | 'active' | 'next' };

export function ReviewDialog({ ownerName, businessName, resubmitted, senderE164, waLink, onClose }: ReviewDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const firstName = ownerName.trim().split(/\s+/)[0] || 'there';

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const steps: Step[] = [
    {
      title: resubmitted ? 'Details updated' : 'Application received',
      body: resubmitted ? 'We already had you. Your latest details are saved.' : 'Safely in our queue. Just now.',
      state: 'done',
    },
    {
      title: 'Our team reviews it',
      body: 'We check every pilot business by hand. Usually within a day.',
      state: 'active',
    },
    {
      title: 'HisabKitab messages you',
      body: 'You get a WhatsApp message on the number you gave us.',
      state: 'next',
    },
    {
      title: 'Reply and you are in',
      body: 'One reply starts your 14-day free trial. Snap your first bill.',
      state: 'next',
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 backdrop-blur-sm animate-fade-in sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
        aria-describedby="review-desc"
        className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-card bg-surface shadow-device animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* khata header: ruled ledger paper with the review stamp */}
        <div
          className="relative overflow-hidden rounded-t-card border-b border-hairline bg-cream px-6 pb-6 pt-7 sm:px-8"
          style={{
            backgroundImage:
              'repeating-linear-gradient(to bottom, transparent 0, transparent 27px, rgba(246,139,31,0.18) 27px, rgba(246,139,31,0.18) 28px)',
          }}
        >
          <div className="absolute inset-y-0 left-10 w-px bg-red-300/60" aria-hidden="true" />
          <div
            className="absolute right-5 top-5 rounded-control border-[3px] border-primary px-3 py-1 font-mono text-xs font-bold uppercase tracking-[0.2em] text-primary opacity-90 animate-stamp sm:right-7 sm:top-6 sm:text-sm"
            aria-hidden="true"
          >
            In review
          </div>
          <div className="pl-8">
            <div className="text-4xl" aria-hidden="true">
              🎉
            </div>
            <h3 id="review-title" className="mt-3 pr-24 font-serif text-2xl font-semibold leading-tight text-ink sm:text-3xl">
              {resubmitted ? `Still in the queue, ${firstName}` : `You are on the list, ${firstName}!`}
            </h3>
            <p id="review-desc" className="mt-2 text-muted">
              <b className="text-ink">{businessName}</b> is with our team for review. We are onboarding a small group of
              businesses by hand, so every pilot gets real attention.
            </p>
          </div>
        </div>

        <ol className="space-y-0 px-6 py-6 sm:px-8">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="relative flex gap-4 pb-5 last:pb-0 animate-rise"
              style={{ animationDelay: `${0.45 + i * 0.12}s` }}
            >
              {i < steps.length - 1 ? (
                <span
                  className={`absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-0.5 ${s.state === 'done' ? 'bg-primary' : 'bg-hairline'}`}
                  aria-hidden="true"
                />
              ) : null}
              <span
                className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-sm font-semibold ${
                  s.state === 'done'
                    ? 'bg-primary text-white'
                    : s.state === 'active'
                      ? 'border-2 border-primary bg-surface text-primary'
                      : 'border-2 border-hairline bg-surface text-muted'
                }`}
                aria-hidden="true"
              >
                {s.state === 'done' ? '✓' : i + 1}
                {s.state === 'active' ? (
                  <span className="absolute inset-0 animate-ping rounded-pill border-2 border-primary/50" />
                ) : null}
              </span>
              <div className="pt-1">
                <p className={`font-medium ${s.state === 'next' ? 'text-muted' : 'text-ink'}`}>
                  {s.title}
                  {s.state === 'active' ? (
                    <span className="ml-2 rounded-pill bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">now</span>
                  ) : null}
                </p>
                <p className="text-sm text-muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mx-6 mb-6 rounded-control border border-wa-green/30 bg-wa-out/50 px-4 py-3 text-sm text-ink sm:mx-8">
          <b>Tip:</b> nothing to do right now. We have not sent you any code, so you do not need to watch for one.
          {senderE164 ? (
            <>
              {' '}
              Save <b className="whitespace-nowrap">{senderE164}</b> as &ldquo;HisabKitab&rdquo; so you spot our message.
            </>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-3 px-6 pb-7 sm:flex-row sm:justify-end sm:px-8">
          {waLink ? (
            <a
              href={waLink.replace(/\?text=.*$/, '')}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-control border border-hairline px-5 py-3 font-medium text-ink transition hover:border-wa-green hover:text-wa-header"
            >
              Open WhatsApp
            </a>
          ) : null}
          <button ref={closeRef} type="button" onClick={onClose} className="btn-primary justify-center">
            Got it, I will wait
          </button>
        </div>
      </div>
    </div>
  );
}
