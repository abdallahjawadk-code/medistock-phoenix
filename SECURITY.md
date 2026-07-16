# Security Policy

## Supported version

Security fixes are applied to the production branch, `master`. Older commits and
unmerged branches are not supported releases.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities, credentials, medical data, or
deployment details in a public issue.

Use GitHub's private vulnerability reporting flow for this repository:

https://github.com/abdallahjawadk-code/medistock-phoenix/security/advisories/new

If that flow is unavailable, contact the repository owner privately and include:

- the affected URL, component, or commit;
- reproducible steps that do not modify production data;
- the likely impact and any prerequisites;
- a minimal proof of concept with all secrets and personal data removed.

The project owner will acknowledge a complete report, assess severity, prepare a
tested fix, and coordinate disclosure after the fix is deployed. Never test by
deleting or changing production data, bypassing authorization for another user,
or running database migrations.

## سياسة الإبلاغ الأمني

لا تنشر الثغرات أو بيانات الاعتماد أو البيانات الطبية أو تفاصيل النشر في Issue
عام. استخدم Security Advisory الخاص بالمستودع، أو تواصل بصورة خاصة مع مالك
المستودع. يجب أن يكون الاختبار غير هدّام وألا يغيّر بيانات الإنتاج أو صلاحيات
المستخدمين أو مخطط قاعدة البيانات.
