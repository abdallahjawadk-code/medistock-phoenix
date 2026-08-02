/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from '../LoginScreen';

const ROOT = process.cwd();

const app = vi.hoisted(() => ({
  lang: 'en' as 'en' | 'ar',
  signIn: vi.fn(),
  requestPasswordReset: vi.fn(),
}));

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: app.lang,
    theme: 'light',
    toggleLang: vi.fn(),
    toggleTheme: vi.fn(),
    signIn: app.signIn,
    requestPasswordReset: app.requestPasswordReset,
    configured: true,
  }),
}));

describe('A7.2.5 user-controlled password reveal', () => {
  beforeEach(() => {
    app.lang = 'en';
    app.signIn.mockReset().mockResolvedValue({ ok: false, error: 'INVALID_CREDENTIALS' });
    app.requestPasswordReset.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);

  it('defaults hidden and preserves value, selection and input focus across pointer toggles', () => {
    render(<LoginScreen />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Show password' });

    fireEvent.change(input, { target: { value: 'A-luxury-secret' } });
    input.focus();
    input.setSelectionRange(2, 8, 'forward');
    expect(input).toHaveAttribute('type', 'password');
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);

    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('A-luxury-secret');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(8);
    expect(document.activeElement).toBe(input);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('title', 'Hide password');
  });

  it('exposes exact Arabic accessible names and keeps native keyboard-button semantics', () => {
    app.lang = 'ar';
    render(<LoginScreen />);
    const toggle = screen.getByRole('button', { name: 'إظهار كلمة المرور' });
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('title', 'إظهار كلمة المرور');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'إخفاء كلمة المرور' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('returns to password mode on form reset, successful submit and remount without changing auth arguments', async () => {
    app.signIn.mockResolvedValue({ ok: true });
    const view = render(<LoginScreen />);
    const email = screen.getByLabelText(/username or email/i);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'operator' } });
    fireEvent.change(input, { target: { value: 'same-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    fireEvent.reset(input.closest('form') as HTMLFormElement);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('same-value');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(input).toHaveAttribute('type', 'password'));
    expect(app.signIn).toHaveBeenCalledWith('operator@local.medistock.invalid', 'same-value');

    view.unmount();
    render(<LoginScreen />);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('marks invalid fields and disables field controls only while the existing submit is busy', async () => {
    let finish: ((value: { ok: true }) => void) | undefined;
    app.signIn.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<LoginScreen />);
    const email = screen.getByLabelText(/username or email/i);
    const input = screen.getByLabelText('Password');

    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(email, { target: { value: 'operator' } });
    fireEvent.change(input, { target: { value: 'same-value' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
    finish?.({ ok: true });
    await waitFor(() => expect(input).not.toBeDisabled());
  });

  it('keeps the reveal local, timer-free and presentation-scoped with reduced-motion coverage', () => {
    const screenSource = readFileSync(join(ROOT, 'src/features/auth/LoginScreen.tsx'), 'utf8');
    const css = readFileSync(join(ROOT, 'src/shared/lib/phase-a-auth-welcome-signature.css'), 'utf8');
    const convergenceCss = readFileSync(join(ROOT, 'src/shared/lib/phase-a-visual-convergence.css'), 'utf8');

    expect(screenSource).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\.|telemetry|setTimeout/);
    expect(screenSource).toContain("autoComplete=\"current-password\"");
    expect(screenSource).toContain('signIn(resolveLoginIdentifier(email), password)');
    expect(css).toMatch(/\.nexus-login__password-toggle[\s\S]*?min-inline-size:\s*44px/);
    expect(css).toMatch(/\.nexus-login__password-toggle[\s\S]*?min-block-size:\s*44px/);
    expect(css).toContain('animation: phase-a725-arrive');
    expect(convergenceCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(convergenceCss).toMatch(/animation-duration:\s*1ms\s*!important/);
  });
});
