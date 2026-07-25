import { Component, type ReactNode } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';

/**
 * REPORTING-RUNTIME-RECOVERY-R04: an unexpected render-time failure inside
 * ANY single report tab (a future defect of the same shape as the Custody
 * Chain/Corrections hook-order crash this recovery fixed, or anything else)
 * must never blank the whole Decision Intelligence Reports screen — let
 * alone the surrounding app shell. This is a class component because React
 * error boundaries have no hook equivalent (getDerivedStateFromError /
 * componentDidCatch are class-only lifecycle methods).
 *
 * Reset contract: pass a `resetKey` that changes whenever the active tab or
 * organization changes (e.g. `${tab}:${orgId}`) as this component's own React
 * `key` at the call site — React unmounts/remounts a component whose `key`
 * changes, which naturally clears any caught error state without this
 * component needing its own effect-based reset logic.
 *
 * Diagnostic safety: only `error.message` and `error.stack` are logged to
 * the console (developer-safe, matches useAsync.ts's existing convention of
 * logging the raw error while showing the user a friendly message). Never
 * logs component props, Supabase responses, tokens, or any other runtime
 * value that could carry organization/session data.
 */
interface Props {
  lang: 'ar' | 'en';
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ReportsTabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Developer-safe: message + stack only, never props/state/response bodies.
    console.error('[phoenix] report tab crashed:', error.message, error.stack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return (
        <PhoenixErrorState
          title={t('dir_tab_error_title', this.props.lang)}
          message={t('dir_tab_error_message', this.props.lang)}
          onRetry={this.reset}
        />
      );
    }
    return this.props.children;
  }
}
