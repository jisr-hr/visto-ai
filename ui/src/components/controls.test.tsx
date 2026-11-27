import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { Chips } from './chips.tsx';
import { Segmented } from './segmented.tsx';
import { Switch } from './ui/switch.tsx';

const base = 'relative h-[26px] w-11 flex-none cursor-pointer rounded-full border-0 p-0 disabled:cursor-default disabled:opacity-55'.split(' ');
const knob = 'absolute top-[3px] left-[3px] size-5 rounded-full bg-card shadow-card transition-[left] duration-150'.split(' ');

test('a switch says whether it is on and changes it', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<Switch checked={false} onChange={onChange} label="Learning" />);
  const off = screen.getByRole('switch', { name: 'Learning' });
  expect(off).toHaveAttribute('type', 'button');
  expect(off).toHaveAttribute('aria-checked', 'false');
  expect(off).toHaveClass(...base, 'bg-muted');
  expect(off).not.toHaveClass('bg-accent');
  const offKnob = off.querySelector('span') as HTMLElement;
  expect(offKnob).toHaveAttribute('aria-hidden', 'true');
  expect(offKnob).toHaveClass(...knob);
  expect(offKnob).not.toHaveClass('left-[21px]');
  await user.click(off);
  expect(onChange).toHaveBeenLastCalledWith(true);

  rerender(<Switch checked onChange={onChange} label="Learning" />);
  const on = screen.getByRole('switch', { name: 'Learning' });
  expect(on).toHaveAttribute('aria-checked', 'true');
  expect(on).toHaveClass(...base, 'bg-accent');
  expect(on).not.toHaveClass('bg-muted');
  // The knob's left is replaced, not added to: two of one property would leave the stylesheet's order to decide.
  expect(on.querySelector('span')).toHaveClass(...knob.filter((name) => name !== 'left-[3px]'), 'left-[21px]');
  expect(on.querySelector('span')).not.toHaveClass('left-[3px]');
  await user.click(on);
  expect(onChange).toHaveBeenLastCalledWith(false);

  onChange.mockClear();
  rerender(<Switch checked onChange={onChange} label="Learning" disabled />);
  expect(screen.getByRole('switch')).toBeDisabled();
  await user.click(screen.getByRole('switch'));
  expect(onChange).not.toHaveBeenCalled();

  rerender(<><span id="name">Auto approval</span><Switch checked onChange={onChange} labelledBy="name" /></>);
  expect(screen.getByRole('switch', { name: 'Auto approval' })).toBeInTheDocument();
});

test('chips are removed by their button and added by name, once each', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<Chips label="Primary branches" values={['main', 'trunk']} onChange={onChange} addLabel="Add branch" />);
  const remove = screen.getByRole('button', { name: 'Remove trunk' });
  expect(remove).toHaveTextContent('x');
  expect(remove).toHaveClass('size-[22px]', 'cursor-pointer', 'rounded-[5px]', 'border-0', 'bg-transparent', 'font-sans', 'text-sm', 'font-medium', 'text-muted');
  expect(screen.getByText('main').closest('span')).toHaveClass(
    'inline-flex', 'items-center', 'gap-1.5', 'rounded-[7px]', 'bg-subtle', 'py-1', 'pr-1.5', 'pl-2.5', 'font-mono', 'text-[13px]',
  );
  await user.click(remove);
  expect(onChange).toHaveBeenLastCalledWith(['main']);

  await user.click(screen.getByRole('button', { name: 'Add branch' }));
  const input = screen.getByRole('textbox', { name: 'Add to Primary branches' });
  expect(input).toHaveFocus();
  expect(input).toHaveClass('w-[180px]', 'font-mono');
  expect(screen.queryByRole('button', { name: 'Add branch' })).toBeNull();
  await user.keyboard('  rc  {Enter}');
  expect(onChange).toHaveBeenLastCalledWith(['main', 'trunk', 'rc']);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Add branch' })).toHaveFocus();

  onChange.mockClear();
  await user.click(screen.getByRole('button', { name: 'Add branch' }));
  await user.keyboard('main{Enter}');
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Add branch' }));
  await user.keyboard('   {Enter}');
  expect(onChange).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Add branch' }));
  await user.keyboard('x{Escape}');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Add branch' })).toHaveFocus();

  rerender(<Chips label="Base branches" values={[]} onChange={onChange} empty="*" />);
  expect(screen.getByText('*')).toHaveClass('text-muted');
  expect(screen.getByText('*').closest('span')?.querySelector('button')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
});

test('the segmented control may have none pressed', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const options = [{ value: 'full', label: 'Full' }, { value: 'light', label: 'Light' }] as const;
  render(<Segmented label="Mode" options={options} value={null} onChange={onChange} />);
  for (const button of screen.getAllByRole('button')) {
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).not.toHaveClass('bg-card');
    expect(button).not.toHaveClass('text-text');
  }
  await user.click(screen.getByRole('button', { name: 'Full' }));
  expect(onChange).toHaveBeenCalledWith('full');
});
