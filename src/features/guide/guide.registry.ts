import { GUIDE_ANCHORS } from './guide.anchors';
import { DASHBOARD_VIEW_PERMISSION, COMMAND_CENTER_SCREEN } from '@/shared/authz/screen-access';
import type { GuideRegistry, GuideTour } from './guide.types';

/**
 * INTERACTIVE-GUIDE-IG1 — the tour registry.
 *
 * Reached only through the lazily-imported engine, so none of this copy is in
 * the shell's chunk (AD-07). Arabic and English are authored side by side and
 * by hand: each pair carries the same operational meaning rather than one
 * being a literal rendering of the other.
 *
 * SCOPE. This wave ships exactly ONE low-risk orientation tour, covering the
 * shell and the Statistics screen. Quarantine («الحجر الصحي») and Suspended
 * from Dispensing («موقوفة الصرف») are deliberately absent — they are IG-2,
 * behind pharmaceutical copy approval, and the two concepts must never be
 * presented as interchangeable (AD-10).
 *
 * SAFETY. Every step below explains or points; none of them instructs the
 * engine to act. There is no step that submits, dispenses, disposes, archives
 * or changes an authorization, and the closing step says explicitly that a
 * real action is performed by closing the guide first.
 *
 * ── IG-1.1, from owner acceptance on a real phone ──────────────────────────
 *
 * TERMINOLOGY. The screen an operator sees is «الإحصائيات» / "Statistics".
 * The guide used to call it «مركز القيادة» / "The Command Center", which is
 * the INTERNAL name — the component, the route, the permission key and the
 * anchors still carry it, correctly, and are deliberately left alone. A guide
 * that names a screen something the screen does not call itself is simply
 * wrong to the person reading it.
 *
 * NAVIGATION. The phone and the desktop do not offer the same way around, so
 * one shared "how you move between screens" step could only be right on one of
 * them. It used to describe the bottom bar as though it were the only option,
 * while the phone also carries a side drawer holding the COMPLETE authorized
 * screen list. There are now three phone steps — the quick bar, the menu
 * button, and the full list inside the drawer — and one desktop step for the
 * sidebar. The step COUNT therefore differs by viewport, which is why nothing
 * may assume a fixed number of steps.
 *
 * ORDER. `help.entry` sits immediately after the navigation block on purpose.
 * On a phone it and the screen-list step both need the drawer open, so keeping
 * them adjacent means the guide borrows the drawer ONCE and gives it back
 * once, rather than opening and closing it around the topbar steps.
 */

const ORIENTATION_TOUR: GuideTour = {
  id: 'guide.tour.orientation',
  title: {
    ar: 'جولة تعريفية سريعة',
    en: 'Quick orientation tour',
  },
  description: {
    ar: 'تعريف بواجهة البرنامج وشاشة الإحصائيات. شرح ومشاهدة فقط، دون تنفيذ أي إجراء.',
    en: 'An introduction to the application shell and the Statistics screen. Explanation only — it performs no action.',
  },
  steps: [
    {
      id: 'welcome',
      title: { ar: 'مرحبًا بك في الدليل', en: 'Welcome to the guide' },
      body: {
        ar: 'هذه جولة قصيرة تشرح أجزاء الواجهة. الدليل يشرح ولا ينفّذ: لن يُرسل أو يُعدّل أي شيء أثناء الجولة.',
        en: 'A short tour of the interface. The guide explains, it does not act: nothing is sent or changed while it runs.',
      },
      anchors: [],
    },

    /* ── Navigation, per viewport ──────────────────────────────────────── */

    {
      // Desktop shows a permanent sidebar and no bottom bar, so this is the
      // whole navigation story there.
      id: 'shell.navigation.desktop',
      title: { ar: 'التنقّل بين الشاشات', en: 'Navigate between screens' },
      body: {
        ar: 'استخدم القائمة الجانبية للتنقّل بين الشاشات المتاحة ضمن صلاحياتك.',
        en: 'Use the sidebar to navigate between the screens available within your permissions.',
      },
      anchors: [GUIDE_ANCHORS.shellNavigationRail],
      viewports: ['desktop'],
    },
    {
      // The phone's fast path — a short shortcut strip, NOT the full menu.
      id: 'shell.navigation.quick',
      title: { ar: 'التنقّل السريع', en: 'Quick navigation' },
      body: {
        ar: 'استخدم الشريط السفلي للوصول السريع إلى الشاشات الأكثر استخدامًا ضمن صلاحياتك.',
        en: 'Use the bottom navigation bar for quick access to the screens you use most within your permissions.',
      },
      anchors: [GUIDE_ANCHORS.shellNavigationBottom],
      viewports: ['phone'],
    },
    {
      // The control itself, explained while the drawer is still closed. The
      // guide is modal, so the operator is TOLD what the button does rather
      // than asked to press it.
      id: 'shell.navigation.menu',
      title: { ar: 'القائمة الجانبية', en: 'Side menu' },
      body: {
        ar: 'استخدم زر القائمة لفتح القائمة الجانبية والوصول إلى جميع الشاشات المتاحة ضمن صلاحياتك.',
        en: 'Use the menu button to open the side menu and access every screen available within your permissions.',
      },
      anchors: [GUIDE_ANCHORS.shellTopbarMenu],
      viewports: ['phone'],
    },
    {
      // ...and then the guide opens it, through the shell's own state, so the
      // list being described is the real one this account actually has.
      id: 'shell.navigation.all',
      title: { ar: 'جميع الشاشات', en: 'All screens' },
      body: {
        ar: 'تعرض القائمة الجانبية جميع الشاشات المتاحة لحسابك فقط. وقد تختلف الخيارات الظاهرة بحسب صلاحياتك.',
        en: 'The side menu shows only the screens available to your account. Visible options may differ according to your permissions.',
      },
      anchors: [GUIDE_ANCHORS.shellNavigationDrawer],
      viewports: ['phone'],
      requiresDrawer: true,
    },

    /* ── The way back in ───────────────────────────────────────────────── */

    {
      /**
       * On a phone this entry lives INSIDE the drawer, which is why this step
       * declares `requiresDrawer` and sits next to the screen-list step —
       * owner acceptance saw it render the missing-target fallback for exactly
       * that reason. On desktop the drawer does not exist, the flag is a
       * no-op, and the topbar control is the target. One entry, one step, both
       * viewports.
       */
      id: 'help.entry',
      title: { ar: 'الدليل والمساعدة', en: 'Guide & Help' },
      body: {
        ar: 'يمكنك العودة إلى الدليل والمساعدة في أي وقت لبدء جولة جديدة، أو استئناف جولة محفوظة، أو إعادة الجولة من البداية.',
        en: 'Return to Guide & Help at any time to start a new tour, resume saved progress, or restart a tour from the beginning.',
      },
      anchors: [GUIDE_ANCHORS.shellTopbarHelp, GUIDE_ANCHORS.shellDrawerHelp],
      requiresDrawer: true,
    },

    /* ── Topbar controls ───────────────────────────────────────────────── */

    {
      id: 'shell.language',
      title: { ar: 'لغة البرنامج', en: 'Application language' },
      body: {
        ar: 'يبدّل هذا الزر لغة البرنامج بين العربية والإنجليزية، ويُحفظ اختيارك لجلساتك القادمة. الدليل يتبع لغة البرنامج ولا لغة له.',
        en: 'This switches the application between Arabic and English, and your choice is remembered for later sessions. The guide follows the application language; it has no language of its own.',
      },
      anchors: [GUIDE_ANCHORS.shellTopbarLanguage],
    },
    {
      id: 'shell.notifications',
      title: { ar: 'التنبيهات', en: 'Notifications' },
      body: {
        ar: 'يعرض الجرس التنبيهات غير المقروءة الخاصة بنطاقك. الرقم عليه هو عددها.',
        en: 'The bell shows unread notifications for your scope. The badge is their count.',
      },
      anchors: [GUIDE_ANCHORS.shellTopbarNotifications],
    },

    /* ── Statistics (internally the Command Center screen) ─────────────── */

    {
      id: 'dashboard.context',
      title: { ar: 'الإحصائيات', en: 'Statistics' },
      body: {
        ar: 'تعرض شاشة الإحصائيات ملخصًا للحالة التشغيلية ضمن نطاق صلاحياتك. ويبيّن شريط النطاق العلوي الجهة التي تُعرض بياناتها.',
        en: 'Statistics provides an operational summary within your authorized scope. The scope bar at the top shows whose data is being displayed.',
      },
      anchors: [GUIDE_ANCHORS.dashboardContextHeader],
      requiresPermissions: [DASHBOARD_VIEW_PERMISSION],
      screen: COMMAND_CENTER_SCREEN,
    },
    {
      id: 'dashboard.kpis',
      title: { ar: 'المؤشرات الرئيسية', en: 'Key indicators' },
      body: {
        ar: 'أرقام مجمّعة تُقرأ بنظرة واحدة: الكميات والأصناف والحالات التي تحتاج انتباهًا.',
        en: 'Aggregated numbers to read at a glance: quantities, items, and the states that need attention.',
      },
      anchors: [GUIDE_ANCHORS.dashboardOverviewKpis],
      requiresPermissions: [DASHBOARD_VIEW_PERMISSION],
      screen: COMMAND_CENTER_SCREEN,
    },
    {
      id: 'dashboard.signals',
      title: { ar: 'الإشارات الحرجة', en: 'Critical signals' },
      body: {
        ar: 'الحالات التي تستحق المتابعة أولًا، مثل قرب انتهاء الصلاحية أو انخفاض الرصيد. هذه قراءة فقط؛ المعالجة تتم من شاشتها المختصة.',
        en: 'What deserves attention first, such as approaching expiry or low stock. This is a reading surface; each case is handled from its own screen.',
      },
      anchors: [GUIDE_ANCHORS.dashboardSignalsPanel],
      requiresPermissions: [DASHBOARD_VIEW_PERMISSION],
      screen: COMMAND_CENTER_SCREEN,
    },

    {
      id: 'closing',
      title: { ar: 'قبل أن تبدأ العمل', en: 'Before you start working' },
      body: {
        ar: 'انتهت الجولة. الدليل للشرح فقط ولا ينفّذ أي إجراء نيابة عنك: أغلق الدليل ثم نفّذ ما تريد من البرنامج إذا كنت مخوّلًا به.',
        en: 'That is the end of the tour. The guide only explains and never acts for you: close it, then carry out what you need from the application itself if you are authorized to.',
      },
      anchors: [],
    },
  ],
};

export const GUIDE_REGISTRY: GuideRegistry = {
  /** Bumped by IG-1.1: the step vocabulary changed shape (viewport-scoped). */
  version: 2,
  tours: [ORIENTATION_TOUR],
};

/** Look up a tour by its stable id. Returns null rather than throwing. */
export function findTour(tourId: string): GuideTour | null {
  return GUIDE_REGISTRY.tours.find(tour => tour.id === tourId) ?? null;
}
