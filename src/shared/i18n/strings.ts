/* ─── MEDISTOCK PHOENIX — Bilingual Strings ─────────────────────────────────
   ALL UI strings live here. Arabic (ar) and English (en) separated cleanly.
   Keys match the design source T dict exactly for traceability.
   ─────────────────────────────────────────────────────────────────────────── */

export type Lang = 'ar' | 'en';

type Dict = Record<string, { ar: string; en: string }>;

export const T: Dict = {
  /* ── Auth ── */
  tagline:        { ar: 'شبكة توفر الصحة · MASAR',          en: 'MASAR Health Availability Network' },
  selectRole:     { ar: 'اختر الدور التجريبي',                en: 'Select Demo Role' },
  demoLogin:      { ar: 'دخول تجريبي',                        en: 'Demo Login' },
  demoData:       { ar: 'بيانات تجريبية',                     en: 'Demo Data' },
  demoOnly:       { ar: 'للأغراض التجريبية فقط',              en: 'Demo purposes only — no real connection' },
  demoSession:    { ar: 'جلسة تجريبية',                       en: 'Demo Session' },
  logout:         { ar: 'خروج',                               en: 'Exit Demo' },

  /* ── Status ── */
  frozen:         { ar: 'مجمد',                               en: 'Frozen' },
  safe_frozen:    { ar: 'مجمد بأمان',                         en: 'Safe Frozen' },
  healthy:        { ar: 'سليم',                               en: 'Healthy' },
  safemode:       { ar: 'الوضع الآمن',                        en: 'Safe Mode' },
  quarantine:     { ar: 'عزل',                                en: 'Quarantine' },
  operational:    { ar: 'تشغيلي',                             en: 'Operational' },
  active:         { ar: 'نشط',                                en: 'Active' },
  inactive:       { ar: 'غير نشط',                            en: 'Inactive' },
  blocked:        { ar: 'محظور',                              en: 'Blocked' },
  connected:      { ar: 'متصل',                               en: 'Connected' },

  /* ── Navigation ── */
  nav_dash:       { ar: 'لوحة التحكم',                        en: 'Dashboard' },
  nav_editor:     { ar: 'محرر التوفر',                        en: 'Availability Editor' },
  nav_reg:        { ar: 'سجل العناصر',                        en: 'Item Registry' },
  nav_mesh:       { ar: 'عرض الشبكة',                         en: 'Mesh View' },
  nav_qr:         { ar: 'مركز QR',                            en: 'QR Center' },
  nav_health:     { ar: 'صحة النظام',                         en: 'System Health' },
  nav_intake:     { ar: 'الإدخال',                             en: 'Intake' },
  nav_reports:    { ar: 'التقارير',                           en: 'Reports' },
  nav_mobile:     { ar: 'العرض المحمول',                      en: 'Mobile View' },
  more:           { ar: 'المزيد',                             en: 'More' },

  /* ── Institutions ── */
  marjan:         { ar: 'مستشفى مرجان التعليمي',              en: 'Marjan Teaching Hospital' },
  hilla:          { ar: 'مستشفى الحلة العام',                 en: 'Al-Hilla General Hospital' },
  babil:          { ar: 'مجمع بابل الطبي',                    en: 'Babil Medical Complex' },
  mahawil:        { ar: 'مستشفى المحاويل',                    en: 'Al-Mahawil Hospital' },

  /* ── Availability states ── */
  avail:          { ar: 'متوفر',                              en: 'Available' },
  low:            { ar: 'منخفض',                              en: 'Low' },
  miss:           { ar: 'مفقود',                              en: 'Missing' },
  units:          { ar: 'وحدة',                               en: 'units' },
  expires30:      { ar: 'تنتهي خلال ٣٠ يوم',                  en: 'Expires in 30 days' },
  safemode_desc:  { ar: 'وضع القراءة فقط نشط',               en: 'Read-only mode active' },

  /* ── Dashboard ── */
  dash_sub:       { ar: 'نظرة عامة · بيانات تجريبية',        en: 'System overview · Demo data' },
  m_inst:         { ar: 'مؤسسات نشطة',                        en: 'Active Institutions' },
  m_avail:        { ar: 'أصناف متوفرة',                       en: 'Available Items' },
  m_low:          { ar: 'مخزون منخفض',                        en: 'Low Stock' },
  m_miss:         { ar: 'أصناف مفقودة',                       en: 'Missing Items' },
  m_exp:          { ar: 'قرب انتهاء الصلاحية',                en: 'Near Expiry' },
  m_bridge:       { ar: 'صحة الجسور',                         en: 'Bridge Health' },
  m_safe:         { ar: 'وحدات الوضع الآمن',                  en: 'Safe Mode Modules' },
  m_upd:          { ar: 'آخر تحديث',                          en: 'Last Update' },
  inst_status:    { ar: 'حالة المؤسسات',                      en: 'Institution Status' },
  alerts:         { ar: 'التنبيهات الأخيرة',                  en: 'Recent Alerts' },
  quick:          { ar: 'الإجراءات السريعة',                  en: 'Quick Actions' },
  editor_desc:    { ar: 'تحديث توفر الأدوية والمستلزمات',     en: 'Update drug & supply availability' },
  health_desc:    { ar: 'مراقبة حالة النظام والجسور',          en: 'Monitor system & bridge health' },
  reports_desc:   { ar: 'تقارير وسجلات التدقيق',              en: 'Reports and audit logs' },

  /* ── Editor ── */
  editor_sub:     { ar: 'تعديل بيانات التوفر يدوياً',          en: 'Manually edit availability records' },
  scope:          { ar: 'نطاق مؤسسي',                         en: 'Institution scope' },
  select_inst:    { ar: 'اختر المؤسسة',                       en: 'Select Institution' },
  single:         { ar: 'إدخال مفرد',                         en: 'Single Entry' },
  batch:          { ar: 'إدخال جماعي',                        en: 'Batch Entry' },
  item:           { ar: 'الصنف',                              en: 'Item' },
  qty:            { ar: 'الكمية',                             en: 'Quantity' },
  unit:           { ar: 'الوحدة',                             en: 'Unit' },
  batch_no:       { ar: 'رقم الدفعة',                         en: 'Batch No.' },
  expiry:         { ar: 'تاريخ الانتهاء',                     en: 'Expiry Date' },
  notes:          { ar: 'ملاحظات',                            en: 'Notes' },
  notes_ph:       { ar: 'أي ملاحظات إضافية...',               en: 'Any additional notes...' },
  batch_items:    { ar: 'الأصناف الجماعية',                   en: 'Batch Items' },
  add_row:        { ar: 'إضافة صف',                           en: 'Add Row' },
  valid:          { ar: 'صالح',                               en: 'Valid' },
  invalid:        { ar: 'غير صالح',                           en: 'Invalid' },
  qty_err:        { ar: 'الكمية يجب أن تكون أكبر من صفر',     en: 'Quantity must be greater than zero' },
  review:         { ar: 'مراجعة الملخص',                      en: 'Review Summary' },
  safe_count:     { ar: 'آمن',                                en: 'safe' },
  blocker:        { ar: 'مانع',                               en: 'blocker' },
  warnings:       { ar: 'تحذيرات',                            en: 'warnings' },
  blocker_msg:    { ar: '⚠ يوجد مانع — يرجى مراجعة الكمية السالبة قبل التطبيق', en: '⚠ Blocker found — review negative quantity before applying' },
  apply:          { ar: 'تطبيق التغييرات',                    en: 'Apply Changes' },
  apply_note:     { ar: 'سيُطلب التأكيد قبل التطبيق · لا تطبيق تلقائي', en: 'Confirmation required before applying · No auto-apply' },
  apply_success:  { ar: 'تم التطبيق بنجاح (تجريبي)',           en: 'Applied successfully (demo)' },

  /* ── Item Registry ── */
  reg_sub:        { ar: 'إدارة الأصناف المحلية للمؤسسة',       en: 'Manage institution-local items' },
  add_item:       { ar: 'إضافة صنف',                          en: 'Add Item' },
  scope_note:     { ar: 'النطاق: الأصناف المحلية فقط · لا قاموس دواء مركزي', en: 'Scope: Local institution items only · No central drug dictionary' },
  search:         { ar: 'بحث...',                             en: 'Search...' },
  lcode:          { ar: 'الرمز المحلي',                       en: 'Local Code' },
  mfr:            { ar: 'الشركة المصنعة',                     en: 'Manufacturer' },
  cat:            { ar: 'الفئة',                              en: 'Category' },
  similar_warn:   { ar: 'تحذير: صنف مشابه موجود',             en: 'Warning: Similar item exists' },

  /* ── Mesh ── */
  mesh_sub:       { ar: 'المؤسسات والجسور والوحدات المحمية',   en: 'Institutions, bridges & protected modules' },

  /* ── QR ── */
  qr_sub:         { ar: 'واجهة QR العامة والإدارية',           en: 'Public QR interface and admin center' },
  privacy_title:  { ar: 'إشعار الخصوصية',                     en: 'Privacy Notice' },
  qr_privacy:     { ar: 'يعرض QR العام معلومات التوفر الآمنة فقط ولا يكشف بيانات الدُفعات الحساسة أو سجلات التدقيق الداخلية أو القيم الديناميكية الخام.', en: 'Public QR shows safe availability only and does not expose sensitive batch, internal audit, or raw dynamic values.' },
  qr_public_label:{ ar: 'بيانات التوفر العامة',               en: 'Public Availability Data' },
  qr_public_avail:{ ar: 'قائمة التوفر العام',                 en: 'Public Availability List' },
  qr_active:      { ar: 'نشط',                                en: 'Active' },
  qr_no_expose:   { ar: 'لا كشف لبيانات الدُفعات أو التدقيق الداخلي', en: 'No batch or internal audit data exposed' },
  last_upd:       { ar: 'آخر تحديث',                          en: 'Last updated' },
  today:          { ar: 'اليوم',                              en: 'Today' },

  /* ── System Health ── */
  health_sub:     { ar: 'للقراءة فقط · بيانات تجريبية',       en: 'Read-only · Demo data' },
  global_status:  { ar: 'الحالة العامة',                      en: 'Global Status' },
  modules:        { ar: 'وحدات',                              en: 'Modules' },
  module_health:  { ar: 'صحة الوحدات',                        en: 'Module Health' },
  mod_avail_read: { ar: 'Availability Read Bridge',           en: 'Availability Read Bridge' },
  mod_editor:     { ar: 'Manual Availability Editor',         en: 'Manual Availability Editor' },
  mod_qr:         { ar: 'QR Public Access',                   en: 'QR Public Access' },
  mod_intake:     { ar: 'Intake Capsule (Frozen)',             en: 'Intake Capsule (Frozen)' },
  actions:        { ar: 'إجراءات',                            en: 'actions' },
  bridge_gov:     { ar: 'حوكمة الجسور',                       en: 'Bridge Governance' },
  recovery_q:     { ar: 'قائمة الاسترداد',                    en: 'Recovery Queue' },
  recovery_clear: { ar: 'قائمة الاسترداد فارغة',              en: 'Recovery queue is clear' },
  event_log:      { ar: 'سجل الأحداث',                        en: 'Event Log' },
  system:         { ar: 'النظام',                             en: 'System' },
  ev1:            { ar: 'تحديث التوفر — مرجان',               en: 'Availability update — Marjan' },
  ev2:            { ar: 'تفعيل الوضع الآمن — الحلة',          en: 'Safe mode activated — Hilla' },
  ev3:            { ar: 'إضافة صنف جديد — بابل',              en: 'New item added — Babil' },
  ev4:            { ar: 'بدء تشغيل النظام',                   en: 'System startup' },

  /* ── Intake (frozen) ── */
  intake_sub:          { ar: 'وحدة معطلة عمداً',              en: 'Intentionally disabled module' },
  intake_frozen:       { ar: 'الإدخال مجمد',                   en: 'Intake Frozen' },
  intake_frozen_note:  { ar: 'معطل عمداً ولا يجوز إعادة تفعيله', en: 'Intentionally disabled, must not be reactivated' },
  intake_disabled_msg: { ar: 'هذه الوحدة معطلة عمدًا ولا يجوز إعادة تفعيلها دون تصميم مضبوط جديد.', en: 'This module is intentionally disabled and must not be reactivated without a new controlled design.' },
  blocked_workflows:   { ar: 'سير العمل المحظورة',             en: 'Blocked Workflows' },
  use_editor_instead:  { ar: 'استخدم محرر التوفر المضبوط بدلاً من ذلك', en: 'Use the controlled Availability Editor instead' },

  /* ── Reports ── */
  reports_sub:    { ar: 'بيانات تجريبية للقراءة فقط',         en: 'Demo data · Read only' },
  filter:         { ar: 'تصفية',                              en: 'Filter' },
  export_csv:     { ar: 'تصدير CSV',                          en: 'Export CSV' },
  tab_summary:    { ar: 'الملخص',                             en: 'Summary' },
  tab_low:        { ar: 'مخزون منخفض',                        en: 'Low Stock' },
  tab_miss:       { ar: 'مفقود',                              en: 'Missing' },
  tab_comp:       { ar: 'مقارنة',                             en: 'Comparison' },
  tab_audit:      { ar: 'سجل التدقيق',                        en: 'Audit Log' },

  /* ── Mobile view ── */
  mobile_sub:     { ar: 'عرض مخصص للهاتف المحمول',            en: 'Optimized mobile command view' },
  quick_entry:    { ar: 'إدخال سريع',                         en: 'Quick Entry' },
  view_health:    { ar: 'عرض صحة النظام',                     en: 'View System Health' },
  view:           { ar: 'عرض',                                en: 'View' },

  /* ── Live auth ── */
  login_title:    { ar: 'تسجيل الدخول',                       en: 'Sign In' },
  login_sub:      { ar: 'ادخل بريدك وكلمة المرور للوصول إلى الشبكة', en: 'Enter your email and password to access the network' },
  email:          { ar: 'البريد الإلكتروني',                  en: 'Email' },
  password:       { ar: 'كلمة المرور',                        en: 'Password' },
  sign_in:        { ar: 'دخول',                               en: 'Sign In' },
  signing_in:     { ar: 'جاري الدخول...',                     en: 'Signing in...' },
  invalid_creds:  { ar: 'بيانات الدخول غير صحيحة',            en: 'Invalid email or password' },
  signed_in_as:   { ar: 'جلسة نشطة',                          en: 'Active session' },
  email_required: { ar: 'البريد وكلمة المرور مطلوبان',        en: 'Email and password are required' },

  /* ── Password reset ── */
  forgot_password:  { ar: 'نسيت كلمة المرور؟',                en: 'Forgot password?' },
  reset_title:      { ar: 'إعادة تعيين كلمة المرور',          en: 'Reset Password' },
  reset_sub:        { ar: 'سنرسل رابط إعادة التعيين إلى بريدك', en: 'We will email you a reset link' },
  send_reset:       { ar: 'إرسال رابط الإعادة',               en: 'Send Reset Link' },
  sending:          { ar: 'جاري الإرسال...',                  en: 'Sending...' },
  reset_sent:       { ar: 'تحقق من بريدك',                    en: 'Check your email' },
  reset_sent_msg:   { ar: 'إذا كان البريد مسجلاً، ستصلك رسالة بها رابط لإعادة التعيين.', en: 'If the email is registered, a reset link has been sent.' },
  back_to_login:    { ar: 'العودة لتسجيل الدخول',             en: 'Back to sign in' },
  recovery_title:   { ar: 'اختر كلمة مرور جديدة',             en: 'Set a New Password' },
  recovery_sub:     { ar: 'أدخل كلمة المرور الجديدة لحسابك',  en: 'Enter a new password for your account' },
  new_password:     { ar: 'كلمة المرور الجديدة',             en: 'New password' },
  confirm_password: { ar: 'تأكيد كلمة المرور',               en: 'Confirm password' },
  set_password:     { ar: 'حفظ كلمة المرور',                 en: 'Save Password' },
  saving:           { ar: 'جاري الحفظ...',                    en: 'Saving...' },
  password_short:   { ar: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل', en: 'Password must be at least 8 characters' },
  password_mismatch:{ ar: 'كلمتا المرور غير متطابقتين',       en: 'Passwords do not match' },
  reset_success:    { ar: 'تم تحديث كلمة المرور',             en: 'Password updated' },
  reset_success_msg:{ ar: 'يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.', en: 'You can now sign in with your new password.' },

  /* ── Config / connection ── */
  config_missing: { ar: 'الاتصال بقاعدة البيانات غير مهيأ',    en: 'Database connection is not configured' },
  config_msg:     { ar: 'لم يتم ضبط متغيرات VITE_PHOENIX_SUPABASE_*. الوضع غير المتصل نشط.', en: 'VITE_PHOENIX_SUPABASE_* env vars are not set. Offline mode is active.' },
  offline_badge:  { ar: 'غير متصل · عرض فارغ',                en: 'Offline · empty view' },

  /* ── Live data states ── */
  loading:        { ar: 'جاري التحميل...',                    en: 'Loading...' },
  retry:          { ar: 'إعادة المحاولة',                     en: 'Retry' },
  load_error:     { ar: 'تعذر تحميل البيانات',                en: 'Could not load data' },
  empty_orgs:     { ar: 'لا توجد مؤسسات بعد',                 en: 'No organizations yet' },
  empty_items:    { ar: 'لا توجد أصناف',                      en: 'No items' },
  empty_avail:    { ar: 'لا توجد سجلات توفر',                 en: 'No availability records' },
  empty_qr:       { ar: 'لا توجد رموز QR',                    en: 'No QR codes' },
  empty_audit:    { ar: 'لا توجد سجلات تدقيق',                en: 'No audit entries' },
  empty_hint:     { ar: 'ستظهر البيانات هنا بعد إضافتها',     en: 'Data will appear here once added' },
  all_orgs:       { ar: 'كل المؤسسات',                        en: 'All organizations' },
  select_org:     { ar: 'اختر المؤسسة',                       en: 'Select organization' },
  no_org_scope:   { ar: 'اختر مؤسسة لعرض البيانات',           en: 'Select an organization to view data' },

  /* ── Public QR view ── */
  public_title:   { ar: 'توفر الأدوية العام',                 en: 'Public Drug Availability' },
  public_sub:     { ar: 'بيانات آمنة للعرض العام فقط',        en: 'Safe public-display data only' },
  qr_invalid:     { ar: 'الرمز غير صالح أو معطل',             en: 'QR code is invalid or disabled' },
  qr_scan_again:  { ar: 'يرجى مسح رمز صالح',                  en: 'Please scan a valid code' },

  /* ── Institution Management ── */
  nav_institutions: { ar: 'إدارة المؤسسات',                    en: 'Institutions' },
  inst_sub:         { ar: 'إدارة المؤسسات والمستخدمين والأدوار', en: 'Manage organizations, users & roles' },
  inst_details:     { ar: 'تفاصيل المؤسسة',                    en: 'Organization Details' },
  inst_code:        { ar: 'رمز المؤسسة',                        en: 'Org Code' },
  inst_city:        { ar: 'المدينة',                            en: 'City' },
  inst_email:       { ar: 'البريد الإلكتروني للتواصل',          en: 'Contact Email' },
  inst_name_en:     { ar: 'الاسم (إنجليزي)',                    en: 'Name (English)' },
  inst_name_ar:     { ar: 'الاسم (عربي)',                       en: 'Name (Arabic)' },
  inst_add:         { ar: 'إضافة مؤسسة',                        en: 'Add Organization' },
  inst_save:        { ar: 'حفظ',                                en: 'Save' },
  inst_edit:        { ar: 'تعديل',                              en: 'Edit' },
  inst_warehouses:  { ar: 'المستودعات',                         en: 'Warehouses' },
  inst_points:      { ar: 'نقاط التوزيع',                       en: 'Distribution Points' },
  inst_users:       { ar: 'المستخدمون',                         en: 'Users' },
  inst_no_users:    { ar: 'لا يوجد مستخدمون في هذه المؤسسة',    en: 'No users in this organization' },
  inst_back:        { ar: 'رجوع',                               en: 'Back' },
  inst_created:     { ar: 'تم إنشاء المؤسسة بنجاح',             en: 'Organization created successfully' },
  inst_updated:     { ar: 'تم تحديث المؤسسة بنجاح',             en: 'Organization updated successfully' },
  inst_required:    { ar: 'الحقول المطلوبة ناقصة',               en: 'Required fields are missing' },
  suspended:        { ar: 'معلق',                               en: 'Suspended' },
  archived:         { ar: 'مؤرشف',                              en: 'Archived' },

  /* ── Roles ── */
  role_super_admin:       { ar: 'مدير عام',                     en: 'Super Admin' },
  role_hospital_admin:    { ar: 'مدير مؤسسة',                   en: 'Institution Admin' },
  role_warehouse_manager: { ar: 'مدير مستودع',                  en: 'Warehouse Manager' },
  role_point_operator:    { ar: 'مشغل نقطة',                    en: 'Point Operator' },
  role_viewer:            { ar: 'مشاهد',                        en: 'Viewer' },
  role_change:            { ar: 'تغيير الدور',                  en: 'Change Role' },
  role_updated:           { ar: 'تم تحديث الدور بنجاح',         en: 'Role updated successfully' },
  role_no_escalate:       { ar: 'لا يمكن ترقية إلى مدير عام',    en: 'Cannot escalate to super admin' },
  user_create_notice:     { ar: 'إنشاء المستخدمين يتطلب صلاحيات خادم — غير متوفر من الواجهة', en: 'User creation requires server-side admin — not available from the frontend' },

  /* ── Confirmation dialog ── */
  confirm_apply:  { ar: 'تأكيد التطبيق',                      en: 'Confirm Apply' },
  confirm_msg:    { ar: 'أنت على وشك تطبيق تغييرات التوفر. هذا الإجراء لا يمكن التراجع عنه تلقائياً.', en: 'You are about to apply availability changes. This action cannot be automatically undone.' },
  mode:           { ar: 'الوضع',                              en: 'Mode' },
  cancel:         { ar: 'إلغاء',                              en: 'Cancel' },
  confirm_btn:    { ar: 'تأكيد وتطبيق',                       en: 'Confirm & Apply' },
};

export function t(key: string, lang: Lang): string {
  return T[key]?.[lang] ?? key;
}
