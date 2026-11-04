/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { NeedsWorkspaceTabs } from './NeedsWorkspaceTabs';
afterEach(cleanup);
function Draft() { const [value, setValue] = useState(''); return <input aria-label="Annual quantity" value={value} onChange={e => setValue(e.target.value)} />; }
it.each(['ar', 'en'] as const)('retains manual draft through tabs and supports directional keyboard navigation: %s', lang => {
  render(<NeedsWorkspaceTabs lang={lang} tabs={[{ id: 'entry', label: 'Entry', content: <Draft /> }, { id: 'review', label: 'Review', content: <button disabled>Approve</button> }]} />);
  fireEvent.change(screen.getByLabelText('Annual quantity'), { target: { value: '1200' } });
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Entry' }), { key: lang === 'ar' ? 'ArrowLeft' : 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Review' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByLabelText('Annual quantity')).not.toBeVisible();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Review' }), { key: 'Home' });
  expect(screen.getByLabelText('Annual quantity')).toBeVisible();
  expect(screen.getByLabelText('Annual quantity')).toHaveValue('1200');
});
