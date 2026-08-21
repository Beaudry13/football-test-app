import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton, MenuItem } from './MenuButton';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('the menu is not clipped by the card it sits in', () => {
  /**
   * THE REGRESSION THIS FILE NOW GUARDS.
   *
   * `.card` carries `overflow: hidden`. The menu used to be
   * `position: absolute`, so it was clipped at the card's edge - and when the
   * trigger sat low in a card, EVERY item fell outside it: invisible, and
   * unclickable, with the card's own stretched link occupying those
   * coordinates. A coach reaching for "Move to" navigated into the quiz.
   *
   * jsdom computes no layout, so a test cannot measure the clipping. What it
   * CAN pin is the property that prevents it: the menu is positioned against
   * the viewport, not laid out inside the clipping ancestor. That is the fix,
   * and it is what a future refactor would have to preserve.
   */
  it('POSITIONS AGAINST THE VIEWPORT, NOT INSIDE THE CARD', () => {
    // `position: absolute` is exactly what let `.card`'s overflow:hidden clip
    // the menu away. Reverting this one declaration reintroduces a bug that
    // makes Move, Duplicate and Delete unreachable on a phone, so it is worth
    // pinning even though it means reading the stylesheet.
    // Read as text: jsdom does not apply CSS modules, and Vitest mocks the
    // import to an identity object, so the file itself is the only source.
    const css = readFileSync(
      resolve(process.cwd(), 'src/components/ui/MenuButton.module.css'),
      'utf8',
    );
    const menuRule = css.slice(css.indexOf('.menu {'));

    expect(menuRule).toMatch(/position:\s*fixed/);
    expect(menuRule.slice(0, menuRule.indexOf('}'))).not.toMatch(/position:\s*absolute/);
  });

  it('measures its position from the trigger when it opens', async () => {
    const user = userEvent.setup();
    render(
      <MenuButton label="Actions for Week 1">
        <MenuItem onSelect={vi.fn()}>Duplicate</MenuItem>
      </MenuButton>,
    );

    await user.click(screen.getByRole('button', { name: 'Actions for Week 1' }));

    // Real coordinates, not a stylesheet default - otherwise a fixed menu
    // would sit in the top-left corner of the screen.
    const menu = screen.getByRole('menu');
    expect(menu.style.top).not.toBe('');
    expect(menu.style.right).not.toBe('');
  });

  it('CLOSES ON SCROLL, because a fixed menu cannot follow the page', async () => {
    const user = userEvent.setup();
    render(
      <MenuButton label="Actions for Week 1">
        <MenuItem onSelect={vi.fn()}>Duplicate</MenuItem>
      </MenuButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions for Week 1' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.scroll(window);

    // Staying open would leave it stranded beside whatever scrolled past.
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('closes on resize for the same reason', async () => {
    const user = userEvent.setup();
    render(
      <MenuButton label="Actions for Week 1">
        <MenuItem onSelect={vi.fn()}>Duplicate</MenuItem>
      </MenuButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions for Week 1' }));

    fireEvent(window, new Event('resize'));

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
