# حزمة صور MediStock Phoenix المصدرية

هذه الحزمة جاهزة للاستخراج في جذر المستودع `D:\phoenix`. جميع الأسماء ثابتة ومطابقة لعقد التصميم.

## المحتويات

- `phoenix-login-master.png` — لوحة الدخول السينمائية بلا نص أو عناصر واجهة، مع مساحة آمنة لنموذج RTL.
- `phoenix-welcome-keyframe-master.png` — لقطة الترحيب المرجعية المعتمدة، وتتضمن النصوص داخل الصورة؛ تستخدم مرجعًا بصريًا فقط.
- `phoenix-welcome-clean-plate-master.png` — نسخة الترحيب النظيفة بلا نصوص أو أزرار، مناسبة للتركيب الحركي وWebGL.
- `phoenix-dashboard-reference-master.png` — مرجع بصري للـDigital Twin ولوحة المعلومات، وليس مصدر بيانات أو واجهة ثابتة.
- `phoenix-babil-map-master.png` — لوحة زخرفية غير جغرافية وغير GIS؛ لا تعتمد لإحداثيات أو مسارات تشغيلية.
- `phoenix-app-icon-master.png` — أيقونة مصدرية 2048×2048 مع منطقة أمان مناسبة لسطح المكتب والهاتف وPWA.

## الاستخراج في PowerShell

من مكان تنزيل الملف المضغوط:

```powershell
Expand-Archive .\MediStock-Phoenix-Source-Images.zip -DestinationPath D:\phoenix -Force
```

بعدها ستكون الصور هنا:

```text
D:\phoenix\design\phoenix-source\
```

## قواعد الاستخدام الإنتاجي

1. لا توضع أي كتابة عربية أو إنجليزية داخل صور التشغيل؛ النصوص تظل HTML/CSS قابلة للترجمة والوصول.
2. صورة `phoenix-welcome-keyframe-master.png` مرجع للمشهد فقط بسبب النص المخبوز داخلها؛ استخدم clean plate في التشغيل.
3. صورة بابل `DECORATIVE_NON_GIS_REFERENCE_ONLY`: العقد والمسارات الحقيقية تُبنى حصريًا من بيانات RLS الحية.
4. صورة لوحة المعلومات مرجع فني فقط؛ لا تُعرض منها أرقام أو مؤسسات أو أرصدة وهمية.
5. أنشئ AVIF/WebP محسّنة من النسخ المصدرية أثناء البناء، ولا ترسل ملفات PNG الكبيرة افتراضيًا للهاتف.
6. احفظ fallback ثنائي الأبعاد وطبّق `prefers-reduced-motion` عند بناء WebGL.

راجع `asset-manifest.json` للأبعاد والبصمات والاستخدام المقصود لكل ملف.
