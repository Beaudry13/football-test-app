import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton, MenuItem } from './MenuButton';
import { menuRightOffset, menuTopOffset } from './menuPosition';
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

describe('the menu stays on the screen it is fixed to', () => {
  /**
   * THE SECOND HALF OF THE SAME BUG.
   *
   * Escaping the card's overflow fixed the clipping and introduced a new
   * failure at phone widths. `.wrapper` stretches to fill the card's layout -
   * 277px on a 375px viewport - and the 40px trigger sits at its LEFT end, so
   * aligning the menu's right edge to the TRIGGER's put 87px of a 176px menu
   * off the left of the screen. The old `right: 0` had aligned to the WRAPPER,
   * whose right edge was on screen, which is why the regression only appeared
   * once the menu was measured from the trigger.
   *
   * It was invisible on a desktop, where the trigger and the wrapper end at
   * the same x - so these cases are written at the widths where they differ.
   */
  const MENU = 176;

  it('CLAMPS a left-hand trigger so no part of the menu is off screen', () => {
    // The real measurement: 375px viewport, trigger at 49..89.
    const right = menuRightOffset(89, MENU, 375);
    const left = 375 - right - MENU;

    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(0);
  });

  it('still right-aligns to the trigger when that fits', () => {
    // 1280px viewport, trigger at 1091..1131 - the desktop case, which must
    // not move: the menu hangs under the "..." it belongs to.
    expect(menuRightOffset(1131, MENU, 1280)).toBe(1280 - 1131);
  });

  it('keeps the right edge on screen for a trigger at the very edge', () => {
    // A trigger flush with the viewport's right edge would otherwise ask for
    // an offset of 0 and sit against the glass.
    expect(menuRightOffset(1280, MENU, 1280)).toBeGreaterThan(0);
  });

  it('does not fight a viewport narrower than the menu itself', () => {
    // Nothing can keep a 176px menu fully inside a 100px screen. Anchoring it
    // to the left edge is the least bad answer, and it must not produce a
    // NEGATIVE offset, which would push it off the right instead.
    expect(menuRightOffset(90, MENU, 100)).toBeGreaterThanOrEqual(0);
  });
});

describe('the menu opens where it can actually be used', () => {
  /**
   * THE SAME BUG AS THE LEFT EDGE, ON THE OTHER AXIS, AND WORSE.
   *
   * A menu is `position: fixed` and closes on scroll, so one that opens below
   * the fold is not awkward - it is unreachable, and Rename, Duplicate, Move
   * to and Delete go with it. Measured on a 375x812 screen: a trigger near
   * the bottom of a folder list put its menu at y=816..966, entirely past the
   * bottom of the viewport.
   */
  const H = 150; // a two-item menu
  const VIEWPORT = 812;

  it('opens BELOW the trigger when there is room', () => {
    expect(menuTopOffset(100, 140, H, VIEWPORT)).toBe(144);
  });

  it('FLIPS ABOVE a trigger near the bottom rather than off the screen', () => {
    // The measured case: trigger at y=772 on an 812px screen.
    const top = menuTopOffset(772, 812, H, VIEWPORT);
    expect(top + H).toBeLessThanOrEqual(VIEWPORT);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('stays on screen even when neither side fits', () => {
    // A menu taller than the screen it is on: it cannot fit either way, so it
    // sits as high as it can and lets its own list scroll.
    const top = menuTopOffset(400, 440, 900, VIEWPORT);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('never returns a position that puts the top edge off the screen', () => {
    for (const triggerTop of [0, 50, 300, 600, 780, 811]) {
      const top = menuTopOffset(triggerTop, triggerTop + 40, H, VIEWPORT);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThan(VIEWPORT);
    }
  });
});
