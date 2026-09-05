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
 * shell and the Command Center. Quarantine («الحجر الصحي») and Suspended from
 * Dispensing («موقوفة الصرف») are deliberately absent — they are IG-2, behind
 * pharmaceutical copy approval, and the two concepts must never be presented
 * as interchangeable (AD-10).
 *
 * SAFETY. Every step below explains or points; none of them instructs the
 * engine to act. There is no step that submits, dispenses, disposes, archives
 * or changes an authorization, and the closing step says explicitly that a
 * real action is performed by closing the guide first.
 */

const ORIENTATION_TOUR: GuideTour = {
  id: 'guide.tour.orientation',
  title: {
    ar: 'جولة تعريفية سريعة',
    en: 'Quick orientation tour',
  },
  description: {
    ar: 'تعريف بواجهة البرنامج ولوحة مركز القيادة. شرح ومشاهدة فقط، دون تنفيذ أي إجراء.',
    en: 'An introduction to the application shell and the Command Center. Explanation only — it performs no action.',
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
    {
      id: 'shell.navigation',
      title: { ar: 'التنقّل بين الشاشات', en: 'Moving between screens' },
      body: {
        ar: 'من هنا تنتقل بين شاشات البرنامج. لا تظهر لك إلا الشاشات المصرَّح لك بها.',
        en: 'This is how you move between screens. Only the screens you are authorized to open are listed.',
      },
      anchors: [
        GUIDE_ANCHORS.shellNavigationRail,
        GUIDE_ANCHORS.shellNavigationDrawer,
        GUIDE_ANCHORS.shellNavigationBottom,
      ],
    },
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
    {
      id: 'dashboard.context',
      title: { ar: 'مركز القيادة', en: 'The Command Center' },
      body: {
        ar: 'يلخّص مركز القيادة وضع المخزون ضمن النطاق الذي يسمح به حسابك. السطر العلوي يوضّح النطاق الذي أجاب به الخادم.',
        en: 'The Command Center summarises stock at the scope your account is allowed to read. The line at the top states the scope the server answered at.',
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
      id: 'help.entry',
      title: { ar: 'الدليل والمساعدة', en: 'Guide & Help' },
      body: {
        ar: 'تعود من هنا إلى الدليل في أي وقت، وتستأنف جولة توقّفت أو تعيدها من البداية.',
        en: 'Come back here at any time to reopen the guide, resume a tour you left, or restart it from the beginning.',
      },
      anchors: [GUIDE_ANCHORS.shellTopbarHelp, GUIDE_ANCHORS.shellDrawerHelp],
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
  version: 1,
  tours: [ORIENTATION_TOUR],
};

/** Look up a tour by its stable id. Returns null rather than throwing. */
export function findTour(tourId: string): GuideTour | null {
  return GUIDE_REGISTRY.tours.find(tour => tour.id === tourId) ?? null;
}
