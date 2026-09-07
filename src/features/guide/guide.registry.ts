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
  /**
   * REACHABILITY of the create surface — what governs whether the button is
   * rendered. Deliberately NOT a scope authorization: it is true in part
   * because the profile has candidate outlets, and a candidate outlet is a
   * candidate, never a grant. The exact scope is re-decided when one is chosen
   * and re-checked server-side by the RPC.
   */
  suspensionCreate:  'inventory.suspension.create',
  /**
   * The one PROVEN scoped answer at this level — the org-wide (NULL,NULL)
   * claim. Nothing derived from a candidate list can set it.
   */
  suspensionCreateOrgWide: 'inventory.suspension.create.orgwide',
  suspensionLift:    'inventory.suspension.lift',
} as const;

/**
 * IG-2 — ELEMENT PRESENCE, a third axis that is neither permission nor data
 * state (see guide.types.ts `requiresPresence` and guide.surface.tsx).
 *
 * These say what the panels actually rendered. A step about "this row" is
 * removed when there is no row, instead of being shown as a centred card that
 * would describe a record the operator cannot see — and instead of letting a
 * genuine anchoring defect hide behind that same fallback.
 */
export const GUIDE_PRESENCE = {
  quarantineRegion:     'inventory.quarantine.region',
  quarantineRow:        'inventory.quarantine.row',
  quarantineRowActions: 'inventory.quarantine.rowActions',
  suspensionRegion:     'inventory.suspension.region',
  suspensionRow:        'inventory.suspension.row',
  suspensionRowActions: 'inventory.suspension.rowActions',
  suspensionHistory:    'inventory.suspension.history',
  suspensionCreateArea: 'inventory.suspension.createArea',

  /* ── IG-3 — Inventory Center lifecycle tabs ── */
  intakeBlockedRegion:      'inventory.intake.blockedRegion',
  intakeFormRegion:         'inventory.intake.formRegion',
  stockRegion:              'inventory.stock.region',
  stockRow:                 'inventory.stock.row',
  ledgerRegion:             'inventory.ledger.region',
  incomingRegion:           'inventory.incoming.region',
  incomingRowActions:       'inventory.incoming.rowActions',
  dispatchRegion:           'inventory.dispatch.region',
  dispatchRowActions:       'inventory.dispatch.rowActions',
  returnsRegion:            'inventory.returns.region',
  correctionsRegion:        'inventory.corrections.region',
} as const;

/** The Inventory Center screen and the tabs these tours belong to. */
const INVENTORY_SCREEN = 3;
const QUARANTINE_TAB = 'quarantine';
const SUSPENSIONS_TAB = 'suspensions';
const INTAKE_TAB = 'intake';
const STOCK_TAB = 'stock';
const LEDGER_TAB = 'ledger';
const INCOMING_TAB = 'incoming';
const DISPATCH_TAB = 'dispatch';
const RETURNS_TAB = 'returns';
const CORRECTIONS_TAB = 'corrections';

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
      requiresPresence: [GUIDE_PRESENCE.quarantineRegion],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.identity',
      title: { ar: 'هوية التشغيلة', en: 'Lot identity' },
      /**
       * COPY ACCURACY — what this step may NOT say.
       *
       * The visible line shows the batch number, the national code and the
       * expiry date, and an earlier draft went on to call that triple the
       * identity that decides the release destination. It is not. The program
       * matches on the database's own canonical identity key together with the
       * remaining lot dimensions (`isExactReleaseCandidate` over migration
       * 088's identity constraint), which is strictly broader than the three
       * values printed on the card — two lots can agree on all three and still
       * be different stock of different provenance.
       *
       * Telling an operator otherwise would teach them to expect a match that
       * the program will refuse, and to distrust a correct refusal. So the step
       * describes what is shown, and says the program verifies the FULL
       * identity, without reciting internal detail it has no business exposing.
       */
      body: {
        ar: 'يعرض السطر ما يميّز التشغيلة أمامك: رقم التشغيلة والرمز الوطني وتاريخ الانتهاء. وعند رفع الحجر يتحقق البرنامج من تطابق هوية التشغيلة كاملةً مع الوجهة، وهي أوسع مما يظهر هنا، فلا يقبل وجهة غير مطابقة حتى لو تشابهت هذه القيم.',
        en: 'The line shows what distinguishes the lot for you: its batch number, national code and expiry date. When quarantine is released the program checks the lot’s full identity against the destination — broader than what is shown here — so it refuses a destination that is not an exact match even when these values look alike.',
      },
      anchors: [GUIDE_ANCHORS.quarantineRowIdentity, GUIDE_ANCHORS.quarantineList],
      requiresPresence: [GUIDE_PRESENCE.quarantineRow],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.quantity',
      title: { ar: 'الكمية المحجوزة', en: 'Quarantined quantity' },
      body: {
        ar: 'الرقم المعروض هو الكمية المحجوزة من هذه التشغيلة، وهو الحد الأعلى لأي رفع حجر أو إتلاف.',
        en: 'The number shown is the quantity held from this lot, and it is the upper limit for any release or destruction.',
      },
      anchors: [GUIDE_ANCHORS.quarantineRowQuantity, GUIDE_ANCHORS.quarantineList],
      requiresPresence: [GUIDE_PRESENCE.quarantineRow],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.release',
      title: { ar: 'رفع الحجر', en: 'Releasing from quarantine' },
      body: {
        ar: 'يعيد رفع الحجر كمية إلى تشغيلة مخزون قائمة ومطابقة تمامًا في الهوية. تُطلب الكمية والسبب، وإن لم توجد تشغيلة مطابقة يوضّح البرنامج ذلك ولا يُنشئ واحدة. أغلق الدليل ثم نفّذ الإجراء من زره إذا كنت مخوّلًا.',
        en: 'Releasing returns a quantity to an existing stock lot that matches it exactly in identity. A quantity and a reason are required, and if no matching lot exists the program says so rather than creating one. Close the guide, then use the button itself if you are authorized.',
      },
      anchors: [GUIDE_ANCHORS.quarantineReleaseAction, GUIDE_ANCHORS.quarantineRowActions],
      requiresCapabilities: [GUIDE_CAPABILITIES.quarantineDispose],
      requiresPresence: [GUIDE_PRESENCE.quarantineRowActions],
      tab: QUARANTINE_TAB,
    },
    {
      id: 'quarantine.destroy',
      title: { ar: 'الإتلاف', en: 'Destroying' },
      body: {
        ar: 'الإتلاف يخرج الكمية نهائيًا ولا يضيفها إلى أي رصيد. يتطلب كمية وسببًا مكتوبًا، ولا يمكن التراجع عنه من الواجهة.',
        en: 'Destroying removes the quantity permanently and credits it to no balance anywhere. It requires a quantity and a written reason, and cannot be undone from the interface.',
      },
      anchors: [GUIDE_ANCHORS.quarantineDestroyAction, GUIDE_ANCHORS.quarantineRowActions],
      requiresCapabilities: [GUIDE_CAPABILITIES.quarantineDispose],
      requiresPresence: [GUIDE_PRESENCE.quarantineRowActions],
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
      requiresPresence: [GUIDE_PRESENCE.suspensionRegion],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.scope',
      title: { ar: 'نطاق الإيقاف', en: 'The scope of a suspension' },
      body: {
        ar: 'يوضّح السطر ما إذا كان الإيقاف على مستوى المؤسسة كلها أو على منفذ صرف واحد باسمه. النطاق يحدد أين يتوقف الصرف فعلًا.',
        en: 'The line states whether the suspension covers the whole organization or one named dispensing outlet. The scope is what decides where dispensing actually stops.',
      },
      anchors: [GUIDE_ANCHORS.suspensionRowScope, GUIDE_ANCHORS.suspensionList],
      requiresPresence: [GUIDE_PRESENCE.suspensionRow],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.badge',
      title: { ar: 'شارة موقوف الصرف', en: 'The suspended badge' },
      body: {
        ar: 'تشير الشارة إلى أن المادة موقوفة الصرف في هذا النطاق. تظهر لمن يرى المادة، دون كشف تفاصيل القرار الإداري خلفها.',
        en: 'The badge marks the material as suspended from dispensing in this scope. It is shown to anyone who sees the material, without exposing the administrative detail behind the decision.',
      },
      anchors: [GUIDE_ANCHORS.suspensionRowBadge, GUIDE_ANCHORS.suspensionList],
      requiresPresence: [GUIDE_PRESENCE.suspensionRow],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.create',
      title: { ar: 'إنشاء إيقاف', en: 'Creating a suspension' },
      body: {
        ar: 'يبدأ الإنشاء باختيار المادة، ثم النطاق حين يكون أمامك أكثر من خيار. يُختار السبب من قائمة محددة، ويصبح حقل التفاصيل إلزاميًا مع «سبب آخر». وفتح النموذج ليس قبولًا: يتحقق البرنامج من صلاحيتك على النطاق الذي تختاره. أغلق الدليل ثم نفّذ الإجراء من زره إذا كنت مخوّلًا.',
        en: 'Creating starts with the material, then the scope when more than one is offered. The reason comes from a fixed list, and the detail field is required for "other". Opening the form is not acceptance: the program checks your authorization for the scope you choose. Close the guide, then use the button itself if you are authorized.',
      },
      anchors: [GUIDE_ANCHORS.suspensionSuspendAction, GUIDE_ANCHORS.suspensionCreateArea],
      requiresCapabilities: [GUIDE_CAPABILITIES.suspensionCreate],
      requiresPresence: [GUIDE_PRESENCE.suspensionCreateArea],
      tab: SUSPENSIONS_TAB,
    },
    {
      id: 'suspension.lift',
      title: { ar: 'رفع الإيقاف', en: 'Lifting a suspension' },
      body: {
        ar: 'رفع الإيقاف يعيد السماح بالصرف ضمن النطاق نفسه، ويتطلب سببًا مكتوبًا. ولا يُخرج أي كمية من الحجر الصحي ولا يغيّر بقية شروط صلاحية المخزون.',
        en: 'Lifting allows dispensing again within the same scope and requires a written reason. It releases nothing from quarantine and changes none of the other conditions on the stock.',
      },
      anchors: [GUIDE_ANCHORS.suspensionLiftAction, GUIDE_ANCHORS.suspensionRowActions],
      requiresCapabilities: [GUIDE_CAPABILITIES.suspensionLift],
      requiresPresence: [GUIDE_PRESENCE.suspensionRowActions],
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
      requiresPresence: [GUIDE_PRESENCE.suspensionHistory],
      tab: SUSPENSIONS_TAB,
    },
  ],
};

/**
 * ── IG-3 · «إدخال مواد» / Material intake ──────────────────────────────────
 *
 * Derived from InventoryCenterScreen.tsx's own `IntakeTab`/`IntakeForm` as they
 * are.
 *
 * HELD, on independent review: an earlier revision gated the submit-describing
 * step on PRESENCE alone (the form is on screen), reasoning that with no
 * freshness-provable scope tag on `useWarehouseStockPermissions` (no
 * `dataScopeKey`/`confirmed` equivalent, unlike the fixed
 * useQuarantinePermission), presence was the best available signal. That is
 * wrong: presence answers "does the form exist", never "is `canAdjust`
 * actually true for the CURRENT warehouse right now" — a plain `useAsync`
 * hook can carry warehouse A's settled `true` into the very first render after
 * switching to warehouse B, and an A→B→A revisit repeats the same identity
 * without ever re-proving it. No existing canonical decision in this codebase
 * closes that gap for this hook, and rewriting `useWarehouseStockPermissions`
 * to add one is outside this change's authorized scope. So there is no
 * `intake.submit` step: the tour explains the form's fields (a fact true
 * regardless of who is looking, since typing needs no authorization — only
 * submitting does) and stops there. This is a deliberate, permanent hold, not
 * a capability anyone will ever see flip true — see the PR description's
 * "held units" section.
 */
const INTAKE_TOUR: GuideTour = {
  id: 'guide.tour.intake',
  title: { ar: 'إدخال مواد', en: 'Material intake' },
  description: {
    ar: 'شرح تبويب إدخال المواد: حقول الإدخال اليدوي وحدود مخازن المؤسسات. شرح ومشاهدة فقط.',
    en: 'How the Material Intake tab is laid out: the manual-entry fields, and the limit for institution warehouses. Explanation only.',
  },
  screen: INVENTORY_SCREEN,
  tab: INTAKE_TAB,
  steps: [
    {
      id: 'intake.tab',
      title: { ar: 'تبويب إدخال المواد', en: 'The Material Intake tab' },
      body: {
        ar: 'يسجّل هذا التبويب استلام مواد جديدة في المخزن المحدد حاليًا عبر سجل المخزن مباشرة. الإدخال اليدوي هو الافتراضي.',
        en: 'This tab records newly received materials into the warehouse currently selected, directly through the warehouse ledger. Manual entry is the default.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabIntake],
      tab: INTAKE_TAB,
    },
    {
      id: 'intake.blocked',
      /**
       * COPY ACCURACY — this step's wording is the product's OWN
       * `inv_institution_intake_blocked_description` string (see
       * strings.ts), not a paraphrase: "receives only from pharmacy-
       * department stores, via an incoming transfer or an outlet return —
       * use the Incoming tab ... or the Returns tab". The tour repeats the
       * actual permitted path rather than only naming the restriction.
       */
      title: { ar: 'مخازن المؤسسات', en: 'Institution warehouses' },
      body: {
        ar: 'لا يتوفر الإدخال المباشر لمخازن المؤسسات في هذه الشاشة. يستلم مخزن المؤسسة فقط من مخازن قسم الصيدلة عبر تبويب «الوارد» لاستلام تحويل، أو تبويب «المرتجعات» لاستلام مرتجع منفذ.',
        en: 'Direct intake is not available for institution warehouses on this screen. An institution warehouse receives only from pharmacy-department stores — use the Incoming tab to receive a transfer, or the Returns tab to receive an outlet return.',
      },
      anchors: [GUIDE_ANCHORS.intakeBlockedRegion],
      requiresPresence: [GUIDE_PRESENCE.intakeBlockedRegion],
      tab: INTAKE_TAB,
    },
    {
      id: 'intake.form',
      title: { ar: 'الإدخال اليدوي', en: 'Manual entry' },
      body: {
        ar: 'أدخل الاسم العلمي والكمية المستلمة ونوع التوريد، مع تأكيد وجود أو غياب الرمز الوطني ورقم التشغيلة صراحةً. لا حقل يُترك فارغًا ويُفسَّر تلقائيًا كغياب.',
        en: 'Enter the scientific name, the quantity received, and the supply type, and explicitly confirm whether a national code and a batch number exist. No field is left blank and read as "does not exist".',
      },
      anchors: [GUIDE_ANCHORS.intakeFormRegion],
      requiresPresence: [GUIDE_PRESENCE.intakeFormRegion],
      tab: INTAKE_TAB,
    },
    {
      id: 'intake.closing',
      title: { ar: 'حالة التوفر', en: 'The availability condition' },
      body: {
        ar: 'حالة توفر المادة تُشتق آليًا من سجل المخزن بعد التسجيل، ولا تُدخل يدويًا في أي مكان.',
        en: 'The material’s availability condition is derived automatically from the ledger after recording — it is never entered by hand anywhere.',
      },
      anchors: [],
      tab: INTAKE_TAB,
    },
  ],
};

/**
 * ── IG-3 · «رصيد المخزن» / Warehouse stock ─────────────────────────────────
 *
 * Derived from InventoryCenterScreen.tsx's `StockList`/`BatchRow`.
 *
 * HELD, on independent review — same reasoning as intake above:
 * `useWarehouseStockPermissions` (`canAdjust`/`canCorrect`) has no freshness-
 * provable scope tag, so there is no `stock.movement` step describing the
 * correction-movement button. Presence alone cannot stand in for a fresh
 * grant. Permanent hold, not a pending capability — see the PR description.
 */
const STOCK_TOUR: GuideTour = {
  id: 'guide.tour.stock',
  title: { ar: 'رصيد المخزن', en: 'Warehouse stock' },
  description: {
    ar: 'شرح تبويب رصيد المخزن: ما يعرضه من رصيد حالي لكل تشغيلة. شرح ومشاهدة فقط.',
    en: 'How the Warehouse Stock tab works: the current balance it shows for every lot. Explanation only.',
  },
  screen: INVENTORY_SCREEN,
  tab: STOCK_TAB,
  steps: [
    {
      id: 'stock.tab',
      title: { ar: 'تبويب رصيد المخزن', en: 'The Warehouse Stock tab' },
      body: {
        ar: 'يعرض هذا التبويب الرصيد الحالي لكل تشغيلة في المخزن المحدد — وهو غير تبويب «سجل الحركات» الذي يعرض تاريخ كل حركة.',
        en: 'This tab shows the CURRENT balance of every lot in the selected warehouse — it is not the Movement Ledger tab, which shows the history of every movement.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabStock],
      tab: STOCK_TAB,
    },
    {
      id: 'stock.list',
      title: { ar: 'قائمة التشغيلات', en: 'The list of lots' },
      body: {
        ar: 'يمكن البحث ضمن القائمة بالاسم العلمي أو الاسم التجاري أو الرمز الوطني أو رقم التشغيلة.',
        en: 'The list can be searched by scientific name, trade name, national code or batch number.',
      },
      anchors: [GUIDE_ANCHORS.stockListRegion],
      requiresPresence: [GUIDE_PRESENCE.stockRegion],
      tab: STOCK_TAB,
    },
    {
      id: 'stock.balances',
      title: { ar: 'الرصيد والمحجوز والمتاح', en: 'On hand, reserved and available' },
      body: {
        ar: 'الرصيد هو الكمية الموجودة فعليًا، والمحجوز جزء منها مرتبط بعملية جارية، والمتاح هو ما يمكن التصرف به الآن.',
        en: 'On hand is what physically exists, reserved is the part of it tied to something already in progress, and available is what can be acted on right now.',
      },
      anchors: [GUIDE_ANCHORS.stockRowBalances, GUIDE_ANCHORS.stockListRegion],
      requiresPresence: [GUIDE_PRESENCE.stockRow],
      tab: STOCK_TAB,
    },
    {
      id: 'stock.closing',
      title: { ar: 'حدود هذا التبويب', en: 'What this tab does not do' },
      body: {
        ar: 'هذا التبويب يعرض الرصيد الحالي فقط. لمراجعة كل حركة سابقة بالتفصيل استخدم تبويب سجل الحركات.',
        en: 'This tab shows only the current balance. To review every past movement in detail, use the Movement Ledger tab.',
      },
      anchors: [],
      tab: STOCK_TAB,
    },
  ],
};

/**
 * ── IG-3 · «سجل الحركات» / Movement ledger ─────────────────────────────────
 *
 * Derived from InventoryCenterScreen.tsx's exported `LedgerList`. Read-only —
 * no action of any kind exists on this tab.
 */
const LEDGER_TOUR: GuideTour = {
  id: 'guide.tour.ledger',
  title: { ar: 'سجل الحركات', en: 'Movement ledger' },
  description: {
    ar: 'شرح تبويب سجل الحركات: اختيار تشغيلة ومطالعة تاريخ حركاتها. شرح ومشاهدة فقط.',
    en: 'How the Movement Ledger tab works: choosing a lot and reading its movement history. Explanation only.',
  },
  screen: INVENTORY_SCREEN,
  tab: LEDGER_TAB,
  steps: [
    {
      id: 'ledger.tab',
      title: { ar: 'تبويب سجل الحركات', en: 'The Movement Ledger tab' },
      body: {
        ar: 'يعرض هذا التبويب تاريخ حركات تشغيلة واحدة تختارها — وهو للاطلاع فقط ولا يُنفَّذ منه أي إجراء.',
        en: 'This tab shows the movement history of one lot you choose — it is read-only, and no action is performed from it.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabLedger],
      tab: LEDGER_TAB,
    },
    {
      id: 'ledger.select',
      title: { ar: 'اختيار التشغيلة', en: 'Choosing a lot' },
      body: {
        ar: 'اختر تشغيلة من القائمة لعرض حركاتها. القائمة تضم تشغيلات المخزن المحدد حاليًا.',
        en: 'Choose a lot from the list to see its movements. The list holds the lots of the currently selected warehouse.',
      },
      anchors: [GUIDE_ANCHORS.ledgerSelect],
      tab: LEDGER_TAB,
    },
    {
      id: 'ledger.list',
      title: { ar: 'قراءة الحركات', en: 'Reading the movements' },
      body: {
        ar: 'كل سطر حركة يبيّن نوعها والرصيد قبلها وبعدها ووقتها ومن نفّذها وسببها إن وُجد، إلى جانب رقم المرجع الورقي.',
        en: 'Each movement line shows its type, the balance before and after it, when it happened, who performed it, its reason if any, and its paper reference number.',
      },
      anchors: [GUIDE_ANCHORS.ledgerListRegion],
      requiresPresence: [GUIDE_PRESENCE.ledgerRegion],
      tab: LEDGER_TAB,
    },
    {
      id: 'ledger.closing',
      title: { ar: 'سجل للاطلاع فقط', en: 'A read-only record' },
      body: {
        ar: 'لا يمكن تعديل حركة سابقة من هنا. أي تصحيح لرصيد حالي يتم من تبويب رصيد المخزن، ويُضيف حركة جديدة إلى هذا السجل ولا يُبدّل القديمة.',
        en: 'A past movement cannot be edited from here. Any correction to a current balance is made from the Warehouse Stock tab, and adds a new movement to this record rather than replacing an old one.',
      },
      anchors: [],
      tab: LEDGER_TAB,
    },
  ],
};

/**
 * ── IG-3 · «واردات تجهيز الدائرة» / Incoming department supplies ───────────
 *
 * Derived from InstitutionIncomingSupplies.tsx and receive-model.ts.
 * `canReceive` (`warehouse_transfer.receive`) is read from the GLOBAL,
 * synchronous effective-permission set (`myPermissions`) — unlike the
 * per-warehouse RBAC hooks elsewhere in this file, it carries no A→B→A
 * staleness risk at all, so it is used directly via `requiresPermissions`,
 * the same safe mechanism the orientation tour already uses for
 * `DASHBOARD_VIEW_PERMISSION`.
 */
const INCOMING_TOUR: GuideTour = {
  id: 'guide.tour.incoming',
  title: { ar: 'واردات تجهيز الدائرة', en: 'Incoming department supplies' },
  description: {
    ar: 'شرح تبويب الوارد: استلام التحويلات من مخازن قسم الصيدلة. شرح ومشاهدة فقط.',
    en: 'How the Incoming tab works: receiving transfers from pharmacy-department stores. Explanation only.',
  },
  screen: INVENTORY_SCREEN,
  tab: INCOMING_TAB,
  steps: [
    {
      id: 'incoming.tab',
      title: { ar: 'تبويب الوارد', en: 'The Incoming tab' },
      body: {
        ar: 'يعرض هذا التبويب ما أُرسل إلى هذا المخزن من مخازن قسم الصيدلة ولم يُستلم بعد.',
        en: 'This tab lists what has been sent to this warehouse from pharmacy-department stores and not yet received.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabIncoming],
      requiresPermissions: ['warehouse_transfer.receive'],
      tab: INCOMING_TAB,
    },
    {
      id: 'incoming.list',
      title: { ar: 'القائمة المعلّقة', en: 'The pending list' },
      body: {
        ar: 'كل بطاقة سطر تحويل واحد بانتظار الاستلام، مع الكمية المُرسَلة.',
        en: 'Each card is one transfer line waiting to be received, with the quantity that was sent.',
      },
      anchors: [GUIDE_ANCHORS.incomingListRegion],
      requiresPresence: [GUIDE_PRESENCE.incomingRegion],
      requiresPermissions: ['warehouse_transfer.receive'],
      tab: INCOMING_TAB,
    },
    {
      id: 'incoming.receive',
      /**
       * COPY ACCURACY — the field DEFAULTS to the sent quantity but is fully
       * editable; the program does not assume sent equals received. Changing
       * it requires a written reason (receive-model.ts `validateReceive`).
       */
      title: { ar: 'تأكيد الكمية المستلمة', en: 'Confirming the received quantity' },
      body: {
        ar: 'تظهر الكمية المرسلة مبدئيًا، لكنها تُدخَل يدويًا وتُعدَّل عند الحاجة — البرنامج لا يفترض وصول الكمية كاملة. أي فرق عن المُرسل يتطلب سببًا مكتوبًا. أغلق الدليل ثم نفّذ الإجراء من زره إذا كنت مخوّلًا.',
        en: 'The sent quantity is shown as a starting value, but it is entered and adjusted by hand — the program does not assume the full quantity arrived. Any difference from what was sent requires a written reason. Close the guide, then use the button itself if you are authorized.',
      },
      anchors: [GUIDE_ANCHORS.incomingRowReceiveAction, GUIDE_ANCHORS.incomingListRegion],
      requiresPresence: [GUIDE_PRESENCE.incomingRowActions],
      requiresPermissions: ['warehouse_transfer.receive'],
      tab: INCOMING_TAB,
    },
    {
      id: 'incoming.bulk',
      /**
       * COPY ACCURACY — "accept all safe" is restricted to bulkEligibleLines
       * (not already received/expired/adjusted/etc.) and always accepts at
       * the FULL sent quantity with no difference reason — a distinct,
       * narrower path from the per-line form above.
       */
      title: { ar: 'قبول كل ما هو آمن', en: 'Accept all safe' },
      body: {
        ar: 'يستلم هذا الزر دفعة واحدة كل سطر لم تظهر عليه أي مشكلة — لم تنتهِ صلاحيته ولم يُعدَّل ولم يُستلم سابقًا — بكامل كميته المُرسلة دون سبب اختلاف.',
        en: 'This button receives, in one batch, every line with nothing flagged about it — not expired, not previously adjusted, not already received — at its full sent quantity, with no difference reason.',
      },
      anchors: [GUIDE_ANCHORS.incomingBulkAction],
      requiresPresence: [GUIDE_PRESENCE.incomingRegion],
      requiresPermissions: ['warehouse_transfer.receive'],
      tab: INCOMING_TAB,
    },
    {
      id: 'incoming.closing',
      title: { ar: 'حدود هذا التبويب', en: 'What this tab does not do' },
      body: {
        ar: 'هذا التبويب يخص استلام هذا المخزن فقط. إرسال بضاعة من هذا المخزن إلى المنافذ يتم من تبويب تجهيز المنافذ.',
        en: 'This tab is only about what this warehouse receives. Sending stock out from this warehouse to outlets is done from the Dispatch to Outlets tab.',
      },
      anchors: [],
      requiresPermissions: ['warehouse_transfer.receive'],
      tab: INCOMING_TAB,
    },
  ],
};

/**
 * ── IG-3 · «تجهيز المنافذ» / Dispatch to outlets ───────────────────────────
 *
 * Derived from OutletDispatchOperations.tsx/OutletDispatchComposer.tsx.
 * `canDispatch` (`warehouse_dispatch.create`) is the same kind of GLOBAL,
 * synchronous flag as `canReceive` above — safe as `requiresPermissions`.
 * "Send" is client-gated on the SAME flag (the UI does not distinguish it
 * from `warehouse_dispatch.send`, though the server does) — the copy below
 * says only what the client actually does, per the research finding.
 */
const DISPATCH_TOUR: GuideTour = {
  id: 'guide.tour.dispatch',
  title: { ar: 'تجهيز المنافذ', en: 'Dispatch to outlets' },
  description: {
    ar: 'شرح تبويب تجهيز المنافذ: تحضير شحنة وإرسالها إلى منفذ تابع لهذا المخزن. شرح ومشاهدة فقط.',
    en: 'How the Dispatch to Outlets tab works: composing a shipment and sending it to an outlet of this warehouse. Explanation only.',
  },
  screen: INVENTORY_SCREEN,
  tab: DISPATCH_TAB,
  steps: [
    {
      id: 'dispatch.tab',
      title: { ar: 'تبويب تجهيز المنافذ', en: 'The Dispatch to Outlets tab' },
      body: {
        ar: 'يعرض هذا التبويب شحنات هذا المخزن إلى منافذه، ويتيح تحضير شحنة جديدة.',
        en: 'This tab lists this warehouse’s shipments to its outlets, and offers composing a new one.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabDispatch],
      requiresPermissions: ['warehouse_dispatch.create'],
      tab: DISPATCH_TAB,
    },
    {
      id: 'dispatch.list',
      title: { ar: 'قائمة الشحنات', en: 'The list of shipments' },
      body: {
        ar: 'تعرض القائمة شحنات هذا المخزن بحالاتها — مسوّدة أو مُرسَلة أو ملغاة.',
        en: 'The list shows this warehouse’s shipments and their state — draft, sent, or cancelled.',
      },
      anchors: [GUIDE_ANCHORS.dispatchListRegion],
      requiresPresence: [GUIDE_PRESENCE.dispatchRegion],
      requiresPermissions: ['warehouse_dispatch.create'],
      tab: DISPATCH_TAB,
    },
    {
      id: 'dispatch.create',
      title: { ar: 'تحضير شحنة جديدة', en: 'Composing a new shipment' },
      body: {
        ar: 'يبدأ التحضير باختيار المنفذ الوجهة، ثم إضافة المواد من رصيد هذا المخزن نفسه. لا يُحفَظ شيء على الخادم حتى تؤكّد المراجعة النهائية. أغلق الدليل ثم نفّذ الإجراء من زره إذا كنت مخوّلًا.',
        en: 'Composing starts with choosing the destination outlet, then adding materials from this warehouse’s own stock. Nothing is saved on the server until you confirm the final review. Close the guide, then use the button itself if you are authorized.',
      },
      anchors: [GUIDE_ANCHORS.dispatchCreateAction, GUIDE_ANCHORS.dispatchListRegion],
      requiresPresence: [GUIDE_PRESENCE.dispatchRegion],
      requiresPermissions: ['warehouse_dispatch.create'],
      tab: DISPATCH_TAB,
    },
    {
      id: 'dispatch.send',
      title: { ar: 'إرسال شحنة', en: 'Sending a shipment' },
      body: {
        ar: 'الإرسال خطوة منفصلة عن التحضير: شحنة بحالة «مسوّدة» تبقى غير مرسلة حتى تضغط زر الإرسال، وعندها فقط يتحرك الرصيد وينشأ استلام معلّق لدى المنفذ. أغلق الدليل ثم نفّذ الإجراء من زره إذا كنت مخوّلًا.',
        en: 'Sending is a separate step from composing: a shipment in "draft" state stays unsent until you press Send — only then does stock actually move and a pending receipt is created at the outlet. Close the guide, then use the button itself if you are authorized.',
      },
      anchors: [GUIDE_ANCHORS.dispatchRowActions, GUIDE_ANCHORS.dispatchListRegion],
      requiresPresence: [GUIDE_PRESENCE.dispatchRowActions],
      requiresPermissions: ['warehouse_dispatch.create'],
      tab: DISPATCH_TAB,
    },
    {
      id: 'dispatch.closing',
      title: { ar: 'حدود هذا التبويب', en: 'What this tab does not do' },
      body: {
        ar: 'هذا التبويب يخص إرسال هذا المخزن فقط. استلام المنفذ لما يصله لا يُنفَّذ من هذه الشاشة.',
        en: 'This tab is only about what this warehouse sends. The outlet’s own receipt of what arrives is not performed from this screen.',
      },
      anchors: [],
      requiresPermissions: ['warehouse_dispatch.create'],
      tab: DISPATCH_TAB,
    },
  ],
};

/**
 * ── IG-3 · «استلام مرتجعات المنافذ» / Receive outlet returns ───────────────
 *
 * Derived from InstitutionReturnReceipts.tsx and receive-model.ts.
 *
 * HELD, on independent review: `useReturnReceivePermission` has no
 * freshness-provable scope tag (no `dataScopeKey`/`confirmed`), so there is
 * no `returns.receive` or `returns.bulk` step — presence (a row exists)
 * cannot stand in for a fresh, attributable grant, and this is exactly the
 * screen where the gap is easiest to observe: `canViewReturns` (tab
 * visibility) is deliberately WIDER than `canReceiveReturns` (mutation), so a
 * genuinely read-only actor reaches this tab with every receive control
 * disabled — the pending list is a perfectly valid thing to explain to that
 * actor, and describing the receive/bulk buttons to them would have been
 * wrong regardless of any staleness question. The tour keeps its viewing
 * content (the tab, the pending list, the "nothing arrived → exceptions"
 * business fact) and holds only the two action steps. Permanent hold, not a
 * pending capability — see the PR description.
 */
const RETURNS_TOUR: GuideTour = {
  id: 'guide.tour.returns',
  title: { ar: 'استلام مرتجعات المنافذ', en: 'Receive outlet returns' },
  description: {
    ar: 'شرح تبويب استلام المرتجعات: ما تعرضه قائمة السطور المعلّقة. شرح ومشاهدة فقط.',
    en: 'How the Receive Outlet Returns tab works: what the pending-lines list shows. Explanation only.',
  },
  screen: INVENTORY_SCREEN,
  tab: RETURNS_TAB,
  steps: [
    {
      id: 'returns.tab',
      title: { ar: 'تبويب استلام المرتجعات', en: 'The Receive Outlet Returns tab' },
      body: {
        ar: 'يعرض هذا التبويب سطور شحنات مرتجعة من المنافذ بانتظار الاستلام في هذا المخزن.',
        en: 'This tab lists lines from outlet-returned shipments waiting to be received at this warehouse.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabReturns],
      tab: RETURNS_TAB,
    },
    {
      id: 'returns.list',
      title: { ar: 'القائمة المعلّقة', en: 'The pending list' },
      body: {
        ar: 'كل بطاقة سطر مرتجع واحد بانتظار الاستلام، مع الكمية التي أُرسلت من المنفذ.',
        en: 'Each card is one returned line waiting to be received, with the quantity the outlet sent.',
      },
      anchors: [GUIDE_ANCHORS.returnsListRegion],
      requiresPresence: [GUIDE_PRESENCE.returnsRegion],
      tab: RETURNS_TAB,
    },
    {
      id: 'returns.closing',
      title: { ar: 'حين لا يصل شيء', en: 'When nothing arrives' },
      body: {
        ar: 'سطر لم تصل منه أي كمية يصبح استثناء يُعالَج من تبويب استثناءات المرتجعات، لا من هنا.',
        en: 'A line where nothing at all arrived becomes an exception, handled from the Return Exceptions tab, not from here.',
      },
      anchors: [],
      tab: RETURNS_TAB,
    },
  ],
};

/**
 * ── IG-3 · «استثناءات مرتجعات المنافذ» / Return exceptions — WHOLE TOUR HELD ──
 *
 * A second independent review found that `permittedTours` offered this tour
 * on tab-surface match ALONE — the same defect class already fixed for the
 * six action steps above, but at the TOUR level here, because this tab has
 * no independently-established read entitlement to fall back on. Contrast
 * with `returns`: its tab visibility is `canReceiveReturns ||
 * hasInventoryReadAffordance` — a genuinely wider, separately-sourced read
 * affordance — so a stale-false `canReceiveReturns` still leaves a real
 * "may view" answer standing. This tab's visibility is `canResolveExceptions`
 * ALONE (see InventoryCenterScreen.tsx), itself the settled value of
 * `useOutletReturnExceptionResolvePermission` — the exact plain `useAsync`
 * hook with no freshness-provable scope tag already named above. There is no
 * SECOND, independent signal here the way `hasInventoryReadAffordance` gives
 * `returns` one.
 *
 * Concretely: an operator whose access to THIS warehouse's exceptions was
 * revoked, or who never had it, can still carry a stale `canResolveExceptions
 * === true` from a prior warehouse across an A→B→A revisit long enough for
 * the tab button to have rendered and been clicked once — and once
 * `surface.tab === 'return_exceptions'`, `permittedTours`'s own tour-level
 * `matchesSurface` check passes regardless of whether that stale `true` is
 * still accurate right now. A tab string surviving in local component state
 * after the underlying permission has already flipped false (the panel then
 * renders nothing for that tab) reproduces the identical hazard, absent even
 * a stale permission entry point.
 *
 * No tour-level `requiresCapabilities` gate was added, because the only
 * candidate key is `canResolveExceptions` itself — gating on the very signal
 * that cannot prove its own freshness would not close this gap, it would
 * merely relocate it one level up and make it LOOK closed. Rewriting
 * `useOutletReturnExceptionResolvePermission` to add a freshness tag (the
 * `useQuarantinePermission` technique) is outside this correction's
 * authorized scope. So the entire tour — `return-exceptions.tab`,
 * `.list`, and `.closing` alike — is HELD: removed from
 * `GUIDE_REGISTRY.tours` entirely, not merely stripped of its one action
 * step as in the prior round. This is a stronger conclusion than the first
 * correction reached for this tour, superseding it — see the PR description's
 * "held units" table for the full, current list.
 *
 * Nothing here disputes the underlying business facts this tour used to
 * explain (custody_state='exception_pending' is a zero-quantity receipt;
 * resolution is a separate, additive record — migration 157, verified
 * directly) — only that NO existing signal can honestly gate telling this
 * specific operator, right now, that this specific queue exists.
 */

/**
 * ── IG-3 · «تصحيحات بانتظار الاعتماد» / Corrections awaiting approval ──────
 *
 * Derived from PendingCorrectionsPanel.tsx, useApproveCorrectionPermission.ts,
 * and migrations 098/101 (verified directly). This panel is VIEW +
 * APPROVE/REJECT only — REQUESTING a correction happens elsewhere (the Stock
 * tab's own movement form for a warehouse lot; a separate outlet screen for
 * outlet stock) — the tour says this explicitly rather than implying the
 * request itself happens here.
 *
 * HELD, on independent review: `useApproveCorrectionPermission` has the same
 * freshness limitation as the hooks above — both approval keys are org-wide,
 * but org is still a dependency of the same plain `useAsync` shape, so an
 * organization (or profile/role) change carries the identical A→B→A
 * misattribution risk. There is no `corrections.decide` step. The tour keeps
 * its viewing content (the combined list, where a request actually starts,
 * the closing business fact about what approval does) and holds only the
 * action step. Permanent hold, not a pending capability — see the PR
 * description.
 */
const CORRECTIONS_TOUR: GuideTour = {
  id: 'guide.tour.corrections',
  title: { ar: 'تصحيحات بانتظار الاعتماد', en: 'Corrections awaiting approval' },
  description: {
    ar: 'شرح تبويب التصحيحات: مطالعة الطلبات المعلّقة واعتمادها أو رفضها. شرح ومشاهدة فقط.',
    en: 'How the Corrections tab works: reviewing pending requests and deciding them. Explanation only.',
  },
  screen: INVENTORY_SCREEN,
  tab: CORRECTIONS_TAB,
  steps: [
    {
      id: 'corrections.tab',
      title: { ar: 'تبويب التصحيحات', en: 'The Corrections tab' },
      body: {
        ar: 'يجمع هذا التبويب طلبات تصحيح رصيد المخزن وتصحيح رصيد المنفذ معًا في قائمة واحدة مرتبة زمنيًا، للمطالعة والاعتماد أو الرفض فقط. طلب التصحيح نفسه يبدأ من مكانه: تبويب رصيد المخزن لتصحيح مخزن، أو شاشة المنفذ لتصحيح منفذ.',
        en: 'This tab combines warehouse-stock and outlet-stock correction requests into one time-ordered list, for reviewing and deciding only. Requesting a correction itself starts elsewhere: the Warehouse Stock tab for a warehouse lot, or the outlet’s own screen for outlet stock.',
      },
      anchors: [GUIDE_ANCHORS.inventoryTabCorrections],
      tab: CORRECTIONS_TAB,
    },
    {
      id: 'corrections.list',
      title: { ar: 'القائمة المعلّقة', en: 'The pending list' },
      body: {
        ar: 'كل بطاقة طلب واحد، وتبيّن الرصيد قبل التصحيح وبعده وسببه ونطاقه، مخزنًا كان أو منفذًا.',
        en: 'Each card is one request, showing the balance before and after the correction, its reason, and its scope — warehouse or outlet.',
      },
      anchors: [GUIDE_ANCHORS.correctionsListRegion],
      requiresPresence: [GUIDE_PRESENCE.correctionsRegion],
      tab: CORRECTIONS_TAB,
    },
    {
      /**
       * COPY ACCURACY — the second-person rule is enforced server-side by
       * PROFILE IDENTITY (`proposed_by = v_actor`), not by role — migrations
       * 098/101, verified directly. Kept here as a business-concept fact
       * (what the rule IS), not as an action-authorization claim, since the
       * decide step itself is held (see the module doc comment above).
       */
      id: 'corrections.closing',
      title: { ar: 'الاعتماد ينفّذ التصحيح', en: 'Approval applies the correction' },
      body: {
        ar: 'اعتماد طلب هنا ينفّذ التصحيح فعليًا على الرصيد، ولا يمكن لمن اقترحه اعتماده بنفسه — البرنامج يمنع ذلك بالهوية لا بالدور. القرار لا يُراجَع من هذه الشاشة بعد اتخاذه.',
        en: 'Approving a request here actually applies the correction to the balance, and whoever proposed it cannot approve it themselves — the program prevents this by identity, not by role. The decision is not revisited from this screen once made.',
      },
      anchors: [],
      tab: CORRECTIONS_TAB,
    },
  ],
};

export const GUIDE_REGISTRY: GuideRegistry = {
  /**
   * 2 — IG-1.1 made steps viewport-scoped.
   * 3 — IG-2 adds capability- and surface-scoped tours.
   * 4 — IG-3 adds eight lifecycle tours (intake, stock, ledger, incoming,
   *     dispatch, returns, return exceptions, corrections), all
   *     `requiresPresence`/`requiresPermissions`-gated — no new capability
   *     names and no engine change. Progress recorded under an earlier
   *     version still resolves: it stores a tour id and a step id, both of
   *     which are unchanged for every pre-existing tour.
   *
   * IG-3 CORRECTION — `guide.tour.return-exceptions` (one of the eight added
   * at version 4) is HELD in its entirety as of this correction: its own
   * tab visibility has no independently-established read entitlement the
   * way `returns` does, so tab-surface match alone let `permittedTours`
   * offer it without proof of current access — see the (now-removed) tour's
   * former module doc comment, preserved in git history, for the full
   * reasoning. Seven tours are offered from this stage on. A progress
   * record naming `guide.tour.return-exceptions` from before this
   * correction simply no longer resolves to an offered tour — the same
   * honest "absent, not broken" behavior an id from a decommissioned
   * pre-IG-3 tour would already get.
   */
  version: 4,
  tours: [
    ORIENTATION_TOUR, QUARANTINE_TOUR, SUSPENSION_TOUR,
    INTAKE_TOUR, STOCK_TOUR, LEDGER_TOUR, INCOMING_TOUR, DISPATCH_TOUR,
    RETURNS_TOUR, CORRECTIONS_TOUR,
  ],
};

/** Look up a tour by its stable id. Returns null rather than throwing. */
export function findTour(tourId: string): GuideTour | null {
  return GUIDE_REGISTRY.tours.find(tour => tour.id === tourId) ?? null;
}
