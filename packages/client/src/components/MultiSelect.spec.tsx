import React, { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import MultiSelect from './MultiSelect';

const items = [
  { value: 'alpha', label: 'Alpha Agent' },
  { value: 'beta', label: 'Beta Agent' },
  { value: 'gamma', label: 'Gamma Agent' },
];

function Selection({
  disabled = false,
  onOpenChange,
}: {
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [values, setValues] = useState(['alpha']);
  const optionalProps = {
    disabled,
    showSelectedValues: true,
    showItemCheckboxes: true,
    searchPlaceholder: 'Search agents',
    searchEmptyText: 'No agents found',
    onOpenChange,
    popoverHeader: (
      <button type="button" onClick={() => setValues(items.map((item) => item.value))}>
        All agents
      </button>
    ),
  };

  return (
    <>
      <MultiSelect
        label="Agents"
        items={items}
        selectedValues={values}
        setSelectedValues={setValues}
        {...optionalProps}
      />
      <output aria-label="Selected agents">{values.join(',')}</output>
    </>
  );
}

describe('MultiSelect', () => {
  it('keeps the existing non-searchable selection behavior', async () => {
    const setSelectedValues = jest.fn();
    const user = userEvent.setup();
    render(
      <MultiSelect
        label="Agents"
        items={items}
        selectedValues={['alpha']}
        setSelectedValues={setSelectedValues}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Agents' }));
    await user.click(await screen.findByRole('option', { name: 'Beta Agent' }));

    expect(setSelectedValues).toHaveBeenCalledWith(['alpha', 'beta']);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('searches labels without losing values outside the search results', async () => {
    const user = userEvent.setup();
    render(<Selection />);

    await user.click(screen.getByRole('combobox', { name: 'Agents' }));
    await user.type(await screen.findByRole('textbox', { name: 'Search agents' }), 'BETA');

    expect(screen.queryByRole('option', { name: 'Alpha Agent' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Beta Agent' }));

    expect(screen.getByLabelText('Selected agents')).toHaveTextContent('alpha,beta');
  });

  it('shows an empty state without clearing the selection', async () => {
    const user = userEvent.setup();
    render(<Selection />);

    await user.click(screen.getByRole('combobox', { name: 'Agents' }));
    await user.type(await screen.findByRole('textbox', { name: 'Search agents' }), 'missing');

    expect(screen.getByText('No agents found')).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('Selected agents')).toHaveTextContent('alpha');
  });

  it('keeps the header action available while searching', async () => {
    const user = userEvent.setup();
    render(<Selection />);

    await user.click(screen.getByRole('combobox', { name: 'Agents' }));
    await user.type(await screen.findByRole('textbox', { name: 'Search agents' }), 'beta');
    await user.click(screen.getByRole('button', { name: 'All agents' }));

    expect(screen.getByLabelText('Selected agents')).toHaveTextContent('alpha,beta,gamma');
  });

  it('clears only search text when the menu closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    render(<Selection onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Agents' }));
    await user.type(await screen.findByRole('textbox', { name: 'Search agents' }), 'beta');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
    await user.click(screen.getByRole('combobox', { name: 'Agents' }));

    expect(await screen.findByRole('textbox', { name: 'Search agents' })).toHaveValue('');
    expect(screen.getByLabelText('Selected agents')).toHaveTextContent('alpha');
  });

  it('supports disabling the trigger', () => {
    render(<Selection disabled />);

    expect(screen.getByRole('combobox', { name: 'Agents' })).toBeDisabled();
  });
});
