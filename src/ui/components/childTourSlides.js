// Child tour slides. Most child actions happen on a block overlay (live UI that
// only appears when an app is attempted and blocked), so slides 3 and 4 are
// text-only center cards.

const nav = (target) => () => window.__pearTourNavigate?.(target);

export const CHILD_TOUR_SLIDES = [
  {
    title: 'Welcome to PearGuard',
    body: "Your parent uses PearGuard to help manage screen time on this device. This app shows you what's happening and lets you ask for more time when you need it.",
    navigate: nav('home'),
  },
  {
    title: 'Your Home screen',
    body: 'The tiles show how many apps are blocked, how many are waiting on parent approval, and how many requests you have in progress. Tap any tile to see the details.',
    targetId: 'child-home-tiles',
    navigate: nav('home'),
  },
  {
    title: 'Need more time?',
    body: "When an app is blocked or you've hit your daily limit, tap Request on the block screen to ask your parent. They get a notification and can approve from their device.",
    navigate: nav('home'),
  },
  {
    title: 'Quick override with a PIN',
    body: 'If your parent set up a PIN, you can enter it on the block screen for a short override without waiting for approval. Each use is logged.',
    navigate: nav('home'),
    cta: 'Got it',
  },
];

// Auto-tour after first pairing skips the welcome slide since the welcome card
// already covered that same intro.
export const CHILD_TOUR_AFTER_PAIR_SLIDES = CHILD_TOUR_SLIDES.slice(1);
