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
 * SCOPE. One always-available orientation tour covering the shell and the
 * Statistics screen, plus IG-2's two CONTEXTUAL tours — «الحجر الصحي» /
 * Quarantine and «موقوفة الصرف» / Suspended from Dispensing — each offered
 * only on its own tab, to an operator whose scoped answers admit it.
 *
 * The two IG-2 domains stay strictly apart (AD-10): they never share a step, a
 * badge, or a translated string, and neither tour ever describes an action in
 * one as affecting the other.
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

/**
 * IG-2 — the capability names these tours consume.
 *
 * Each is published by the component that already decided it (see
 * guide.surface.tsx). The guide asks for the DECISION, never for a role, a
 * candidate list, or a global permission key that would not represent the
 * scoped answer.
 */
export const GUIDE_CAPABILITIES = {
  quarantineView:    'inventory.quarantine.view',
  quarantineDispose: 'inventory.quarantine.dispose',
  suspensionView:    'inventory.suspension.view',
  suspensionCreate:  'inventory.suspension.create',
  suspensionLift:    'inventory.suspension.lift',
} as const;

/** The Inventory Center screen and the two tabs these tours belong to. */
const INVENTORY_SCREEN = 3;
const QUARANTINE_TAB = 'quarantine';
const SUSPENSIONS_TAB = 'suspensions';

/**
 * ── IG-2 · «الحجر الصحي» / Quarantine ──────────────────────────────────────
 *
 * Derived from QuarantinePanel.tsx and quarantine.service.ts as they are, not
 * from a summary. Every claim below is something the panel actually does:
 *
 *   • the tab lists what THIS warehouse holds in quarantine, per the warehouse
 *     the screen is scoped to;
 *   • each card shows the lot identity, the quantity, and the quarantine
 *     reason;
 *   • release credits a NAMED existing dispensable lot and offers only exact
 *     canonical-identity matches (`isExactReleaseCandidate`), which is why
 *     "no matching lot" is a real, reachable state rather than an error;
 *   • release and destroy both require a quantity within the held amount and a
 *     written reason;
 *   • destroy credits nothing, anywhere.
 *
 * The tour never says quarantine and suspension affect one another, because
 * they do not: releasing quarantined stock does not lift a dispensing
 * suspension, and it does not make stock dispensable if anything else about it
 * is unfit. The copy explains the program's behaviour and adds no clinical or
 * regulatory rule of its own.
 */
const QUARANTINE_TOUR: GuideTour = {
  id: 'guide.tour.quarantine',
  title: { ar: 'الحجر الصحي', en: 'Quarantine' },
  description: {
    ar: 'شرح تبويب الحجر الصحي: ما يعرضه، وكيف يُرفع الحجر أو يُتلف المخزون. شرح ومشاهدة فقط.',
    en: 'How the Quarantine tab works: what it lists, and how stock is released or destroyed. Explanation only.',
  },
  requiresCapabilities: [GUIDE_CAPABILITIES.quarantineView],
  screen: INVENTORY_SCREEN,
  tab: QUARANTINE_TAB,
  steps: [
    {
      id: 'quarantine.tab',
      title: { ar: 'تبويب الحجر الصحي', en: 'The Quarantine tab' },
      body: {
        ar: 'يعرض هذا التبويب المخزون المحجوز في المخزن المحدد حاليًا ضمن مؤسستك. تغيير المخزن يغيّر القائمة.',
        en: 'This tab lists quarantined stock in the warehouse currently selected within your organization. Changing the warehouse changes the list.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabQuarantine],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.list',
      title: { ar: 'قراءة القائمة', en: 'Reading the list' },
      body: {
        ar: 'كل بطاقة تمثّل كمية محجوزة من تشغيلة واحدة، ويظهر تحتها سبب الحجر. المخزون هنا خارج الصرف حتى يُتخذ قرار بشأنه.',
        en: 'Each card is a quarantined quantity from one lot, with its quarantine reason beneath it. Stock here is out of dispensing until a decision is made about it.',
      },
      anchors: [GUIDE_ANCHORS.quarantineList],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.identity',
      title: { ar: 'هوية التشغيلة', en: 'Lot identity' },
      body: {
        ar: 'يُعرّف السطر التشغيلة برقمها والرمز الوطني وتاريخ الانتهاء. هذه الهوية هي ما يحدد لاحقًا الوجهة المطابقة عند رفع الحجر.',
        en: 'The line identifies the lot by its batch number, national code and expiry date. That identity is what later decides which destination matches when quarantine is released.',
      },
      anchors: [GUIDE_ANCHORS.quarantineRowIdentity],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.quantity',
      title: { ar: 'الكمية المحجوزة', en: 'Quarantined quantity' },
      body: {
        ar: 'الرقم المعروض هو الكمية المحجوزة من هذه التشغيلة، وهو الحد الأعلى لأي رفع حجر أو إتلاف.',
        en: 'The number shown is the quantity held from this lot, and it is the upper limit for any release or destruction.',
      },
      anchors: [GUIDE_ANCHORS.quarantineRowQuantity],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.release',
      title: { ar: 'رفع الحجر', en: 'Releasing from quarantine' },
      body: {
        ar: 'يعيد رفع الحجر كمية إلى تشغيلة مخزون قائمة ومطابقة تمامًا في الهوية. تُطلب الكمية والسبب، وإن لم توجد تشغيلة مطابقة يوضّح البرنامج ذلك ولا يُنشئ واحدة. أغلق الدليل ثم نفّذ الإجراء من زره إذا كنت مخوّلًا.',
        en: 'Releasing returns a quantity to an existing stock lot that matches it exactly in identity. A quantity and a reason are required, and if no matching lot exists the program says so rather than creating one. Close the guide, then use the button itself if you are authorized.',
      },
      anchors: [GUIDE_ANCHORS.quarantineReleaseAction],
      requiresCapabilities: [GUIDE_CAPABILITIES.quarantineDispose],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.destroy',
      title: { ar: 'الإتلاف', en: 'Destroying' },
      body: {
        ar: 'الإتلاف يخرج الكمية نهائيًا ولا يضيفها إلى أي رصيد. يتطلب كمية وسببًا مكتوبًا، ولا يمكن التراجع عنه من الواجهة.',
        en: 'Destroying removes the quantity permanently and credits it to no balance anywhere. It requires a quantity and a written reason, and cannot be undone from the interface.',
      },
      anchors: [GUIDE_ANCHORS.quarantineDestroyAction],
      requiresCapabilities: [GUIDE_CAPABILITIES.quarantineDispose],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.closing',
      title: { ar: 'حدود هذا التبويب', en: 'What this tab does not do' },
      body: {
        ar: 'الحجر الصحي يخص كمية من تشغيلة في مخزن. وهو منفصل عن «موقوفة الصرف»: رفع الحجر لا يرفع إيقاف الصرف عن المادة.',
        en: 'Quarantine concerns a quantity of a lot in a warehouse. It is separate from Suspended from Dispensing: releasing quarantine does not lift a dispensing suspension on the material.',
      },
      anchors: [],
      tab: QUARANTINE_TAB,
    },
  ],
};

/**
 * ── IG-2 · «موقوفة الصرف» / Suspended from Dispensing ──────────────────────
 *
 * Derived from MaterialDispensingSuspensionPanel.tsx and its service. Real
 * behaviour reflected here:
 *
 *   • the panel lists ACTIVE suspensions, with lifted ones behind a separate
 *     history disclosure;
 *   • a suspension names a MATERIAL, scoped either organization-wide or to one
 *     named outlet, and the scope selector appears only when both are actually
 *     reachable for this profile;
 *   • the reason is chosen from a fixed list, an explanation is REQUIRED only
 *     for "other", and the reference document is optional;
 *   • lifting requires a written reason;
 *   • the row badge states the material is suspended, without exposing the
 *     administrative detail behind it.
 *
 * The two domains are kept apart throughout, and no clinical or regulatory
 * requirement is asserted that the program does not implement.
 */
const SUSPENSION_TOUR: GuideTour = {
  id: 'guide.tour.dispensing-suspension',
  title: { ar: 'موقوفة الصرف', en: 'Suspended from Dispensing' },
  description: {
    ar: 'شرح تبويب موقوفة الصرف: ما يعرضه، وكيف يُنشأ الإيقاف أو يُرفع. شرح ومشاهدة فقط.',
    en: 'How the Suspended from Dispensing tab works: what it lists, and how a suspension is created or lifted. Explanation only.',
  },
  requiresCapabilities: [GUIDE_CAPABILITIES.suspensionView],
  screen: INVENTORY_SCREEN,
  tab: SUSPENSIONS_TAB,
  steps: [
    {
      id: 'suspension.tab',
      title: { ar: 'موقوفة الصرف', en: 'Suspended from Dispensing' },
      body: {
        ar: 'إيقاف الصرف قرار إداري يمنع صرف مادة ضمن نطاق محدد. وهو غير الحجر الصحي: الحجر يخص كمية من تشغيلة في مخزن، والإيقاف يخص المادة نفسها.',
        en: 'A dispensing suspension is an administrative decision that stops a material from being dispensed within a defined scope. It is not quarantine: quarantine concerns a quantity of a lot in a warehouse, a suspension concerns the material itself.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabSuspensions],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.active',
      title: { ar: 'الإيقافات النشطة', en: 'Active suspensions' },
      body: {
        ar: 'تعرض القائمة الإيقافات السارية حاليًا ضمن ما يسمح به نطاقك. أما الإيقافات المرفوعة فتُعرض في سجل منفصل أسفل القائمة.',
        en: 'The list shows suspensions currently in force within the scope you are allowed to see. Lifted ones appear in a separate history below the list.',
      },
      anchors: [GUIDE_ANCHORS.suspensionList],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.scope',
      title: { ar: 'نطاق الإيقاف', en: 'The scope of a suspension' },
      body: {
        ar: 'يوضّح السطر ما إذا كان الإيقاف على مستوى المؤسسة كلها أو على منفذ صرف واحد باسمه. النطاق يحدد أين يتوقف الصرف فعلًا.',
        en: 'The line states whether the suspension covers the whole organization or one named dispensing outlet. The scope is what decides where dispensing actually stops.',
      },
      anchors: [GUIDE_ANCHORS.suspensionRowScope],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.badge',
      title: { ar: 'شارة موقوف الصرف', en: 'The suspended badge' },
      body: {
        ar: 'تشير الشارة إلى أن المادة موقوفة الصرف في هذا النطاق. تظهر لمن يرى المادة، دون كشف تفاصيل القرار الإداري خلفها.',
        en: 'The badge marks the material as suspended from dispensing in this scope. It is shown to anyone who sees the material, without exposing the administrative detail behind the decision.',
      },
      anchors: [GUIDE_ANCHORS.suspensionRowBadge],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.create',
      title: { ar: 'إنشاء إيقاف', en: 'Creating a suspension' },
      body: {
        ar: 'يبدأ الإنشاء باختيار المادة، ثم النطاق حين يكون أمامك أكثر من خيار مسموح. يُختار سبب من قائمة محددة، ويصبح حقل التفاصيل إلزاميًا عند اختيار «سبب آخر»، أما المستند المرجعي فاختياري. أغلق الدليل ثم نفّذ الإجراء من زره إذا كنت مخوّلًا.',
        en: 'Creating starts by choosing the material, then the scope when more than one is available to you. A reason is picked from a fixed list, the detail field becomes required when the reason is "other", and the reference document is optional. Close the guide, then use the button itself if you are authorized.',
      },
      anchors: [GUIDE_ANCHORS.suspensionSuspendAction],
      requiresCapabilities: [GUIDE_CAPABILITIES.suspensionCreate],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.lift',
      title: { ar: 'رفع الإيقاف', en: 'Lifting a suspension' },
      body: {
        ar: 'رفع الإيقاف يعيد السماح بالصرف ضمن النطاق نفسه، ويتطلب سببًا مكتوبًا. ولا يُخرج أي كمية من الحجر الصحي ولا يغيّر بقية شروط صلاحية المخزون.',
        en: 'Lifting allows dispensing again within the same scope and requires a written reason. It releases nothing from quarantine and changes none of the other conditions on the stock.',
      },
      anchors: [GUIDE_ANCHORS.suspensionLiftAction],
      requiresCapabilities: [GUIDE_CAPABILITIES.suspensionLift],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.history',
      title: { ar: 'سجل الإيقافات المرفوعة', en: 'History of lifted suspensions' },
      body: {
        ar: 'يحتفظ السجل بالإيقافات التي رُفعت، مع سبب الرفع. وهو للاطلاع فقط ولا يمكن التعديل عليه.',
        en: 'The history keeps suspensions that have been lifted, together with the reason for lifting. It is for reference only and cannot be edited.',
      },
      anchors: [GUIDE_ANCHORS.suspensionHistory],
      tab: SUSPENSIONS_TAB,
    },
  ],
};

export const GUIDE_REGISTRY: GuideRegistry = {
  /**
   * 2 — IG-1.1 made steps viewport-scoped.
   * 3 — IG-2 adds capability- and surface-scoped tours. Progress recorded
   *     under an earlier version still resolves: it stores a tour id and a
   *     step id, both of which are unchanged for the orientation tour.
   */
  version: 3,
  tours: [ORIENTATION_TOUR, QUARANTINE_TOUR, SUSPENSION_TOUR],
};

/** Look up a tour by its stable id. Returns null rather than throwing. */
export function findTour(tourId: string): GuideTour | null {
  return GUIDE_REGISTRY.tours.find(tour => tour.id === tourId) ?? null;
}
