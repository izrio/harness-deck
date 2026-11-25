// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PermissionPicker } from '../src/components/PermissionPicker.tsx';
import * as store from '../src/store.ts';
import { mockVsCodeApi } from './setup.ts';

describe('PermissionPicker & GlideMenu highlight behavior', () => {
  beforeEach(() => {
    mockVsCodeApi();
    store.resetStoreForTests();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    store.resetStoreForTests();
  });

  it('opening PermissionPicker by mouse focuses the active item (Auto) instead of Default and does not show a stray glide highlight', () => {
    store.applyHostMessage({
      type: 'permissions',
      payload: {
        current: 'auto',
        options: ['default', 'accept-edits', 'auto', 'plan'],
        labels: {
          default: { name: 'Default', description: 'Ask before edits and commands, per your permission settings.' },
          'accept-edits': { name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
          auto: { name: 'Auto', description: 'Approve edits and safe commands; ask before irreversible actions.' },
          plan: { name: 'Plan', description: 'Plan carefully before executing a task.' },
        },
      },
    });

    // Simulate a real browser after a pointer click: programmatic focus does not match :focus-visible.
    const origMatches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector === ':focus-visible') return false;
      return origMatches.call(this, selector);
    });

    render(<PermissionPicker disabled={false} />);

    fireEvent.click(screen.getByTestId('permission-picker'));

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(4);
    const defaultItem = items[0]!;
    const autoItem = items[2]!;

    // Focus should land on the currently selected option (Auto), not Default.
    expect(document.activeElement).toBe(autoItem);
    expect(autoItem.getAttribute('aria-current')).toBe('true');
    expect(defaultItem.getAttribute('aria-current')).toBeNull();

    // Non-keyboard programmatic focus must not trigger the sliding hover highlight.
    const glideContainer = autoItem.closest('.group\\/glide-menu') as HTMLElement;
    const highlight = glideContainer.querySelector('[data-glide-highlight]') as HTMLElement;
    expect(glideContainer.getAttribute('data-gliding')).toBeNull();
    expect(highlight.style.opacity).toBe('0');

    // Hovering Default activates the glide highlight and marks the menu as gliding so Auto drops its static bg.
    fireEvent.mouseOver(defaultItem);
    expect(glideContainer.getAttribute('data-gliding')).toBe('true');
    expect(highlight.style.opacity).toBe('1');
    expect(autoItem.className).toContain('group-data-[gliding=true]/glide-menu:bg-transparent');

    // Leaving the menu hides the glide highlight and restores Auto's static active background.
    fireEvent.mouseLeave(glideContainer);
    expect(glideContainer.getAttribute('data-gliding')).toBeNull();
    expect(highlight.style.opacity).toBe('0');
  });

  it('keyboard :focus-visible navigation activates the glide highlight on the focused row', () => {
    store.applyHostMessage({
      type: 'permissions',
      payload: {
        current: 'auto',
        options: ['default', 'auto'],
        labels: {
          default: { name: 'Default' },
          auto: { name: 'Auto' },
        },
      },
    });

    render(<PermissionPicker disabled={false} />);
    fireEvent.click(screen.getByTestId('permission-picker'));

    const [defaultItem, autoItem] = screen.getAllByRole('menuitem') as [HTMLElement, HTMLElement];
    const glideContainer = autoItem.closest('.group\\/glide-menu') as HTMLElement;
    const highlight = glideContainer.querySelector('[data-glide-highlight]') as HTMLElement;

    const origMatches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector === ':focus-visible') return this === defaultItem;
      return origMatches.call(this, selector);
    });

    fireEvent.focus(defaultItem);
    expect(glideContainer.getAttribute('data-gliding')).toBe('true');
    expect(highlight.style.opacity).toBe('1');

    fireEvent.blur(defaultItem, { relatedTarget: document.body });
    expect(glideContainer.getAttribute('data-gliding')).toBeNull();
    expect(highlight.style.opacity).toBe('0');
  });
});
