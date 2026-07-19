import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PresetModal from '../components/PresetModal.jsx';

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue({ ok: true });
});

const basePolicy = {
  childPublicKey: 'childpk',
  apps: { 'com.game': { status: 'allowed', category: 'Games', appName: 'Game' } },
};

function renderModal(policy = basePolicy) {
  return render(
    <PresetModal childPublicKey="childpk" policy={policy} visible={true} onClose={() => {}} onApplied={() => {}} />
  );
}

test('applies an age preset: composes daily cap + category limits + bedtime', async () => {
  renderModal();

  // Pick "Young child" then confirm.
  fireEvent.click(screen.getByText('Young child'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('policy:update', expect.objectContaining({
      childPublicKey: 'childpk',
    }));
  });
  const call = window.callBare.mock.calls.find((c) => c[0] === 'policy:update');
  const p = call[1].policy;
  expect(p.dailyScreenTimeLimitSeconds).toBe(60 * 60);
  expect(p.categories.Games).toEqual({ dailyLimitSeconds: 30 * 60 });
  expect(p.schedules[0]).toMatchObject({ label: 'Bedtime', start: '19:30' });
  // Age preset keeps per-app status.
  expect(p.apps['com.game'].status).toBe('allowed');

  // Confirmation shown.
  expect(await screen.findByText(/Preset applied/i)).toBeInTheDocument();
});

test('applies the allowlist preset: blocks every app', async () => {
  renderModal();

  fireEvent.click(screen.getByText('Allowlist only'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => {
    const call = window.callBare.mock.calls.find((c) => c[0] === 'policy:update');
    expect(call).toBeTruthy();
    expect(call[1].policy.apps['com.game'].status).toBe('blocked');
  });
});

test('Back returns to the preset list without applying', () => {
  renderModal();
  fireEvent.click(screen.getByText('Teen'));
  expect(screen.getByText(/Apply the Teen preset\?/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  // List is shown again; nothing applied.
  expect(screen.getByText('Young child')).toBeInTheDocument();
  expect(window.callBare).not.toHaveBeenCalledWith('policy:update', expect.anything());
});
