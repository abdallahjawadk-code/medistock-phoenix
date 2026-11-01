/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

const getOrganizations = vi.fn(async () => []);
vi.mock('@/app/AppContext', () => ({ useApp: () => ({
  lang: 'en', dir: 'ltr', role: 'outlet_officer', myPermissions: new Set(),
  profile: { full_name: 'Synthetic operator' },
}) }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: () => getOrganizations() }));
import { CommandPalette } from '../CommandPalette';
import { PhoenixSidebar } from '../PhoenixSidebar';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('P4-A shell interactions', () => {
  it('opens the canonical permission-filtered palette from a visible control and restores focus', () => {
    function Harness() {
      const [request, setRequest] = useState(0);
      return <><button onClick={() => setRequest(n => n + 1)}>Search navigation</button>
        <CommandPalette onNavigate={() => undefined} openRequest={request} /></>;
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Search navigation' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Institutions' })).not.toBeInTheDocument();
    expect(getOrganizations).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('expands the compact rail without changing accessible navigation or its handlers', () => {
    const navigate = vi.fn();
    render(<PhoenixSidebar currentScreen={3} onNavigate={navigate} onLogout={() => undefined} />);
    const before = screen.getAllByRole('button').filter(b => b.classList.contains('premium-nav-item')).map(b => b.textContent);
    const toggle = screen.getByRole('button', { name: 'Expand navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true');
    const after = screen.getAllByRole('button').filter(b => b.classList.contains('premium-nav-item')).map(b => b.textContent);
    expect(after).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Outlet Operations' }));
    expect(navigate).toHaveBeenCalledWith(18);
  });
});
