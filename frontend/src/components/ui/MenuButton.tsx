import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { menuRightOffset } from './menuPosition';
import styles from './MenuButton.module.css';

/** Lets a MenuItem close the menu it is in without the caller wiring it up.
 *
 * Closing on ANY click inside the menu was the first attempt and it was wrong:
 * the "Move to" control is a real <select>, and clicking it closed the menu
 * out from under the coach before they could choose a folder. Only choosing an
 * ACTION should close it. */
const CloseMenu = createContext<() => void>(() => {});


/** A quiet "…" that opens a short list of actions.
 *
 * WHY THIS EXISTS. Management actions used to sit permanently on every row -
 * a folder dropdown, Duplicate, and a red Delete on each of a coach's quizzes.
 * That spends permanent interface complexity to save an occasional click, and
 * it put the rarest action (Delete) in the highest-contrast element on the
 * card. This is where those actions go instead.
 *
 * IT MUST NOT TRIGGER WHATEVER IT SITS INSIDE. The card around it is one big
 * link, so every pointer and key event here stops propagating - otherwise
 * reaching for Delete would open the quiz.
 *
 * ALWAYS VISIBLE, NOT HOVER-REVEALED. Hover does not exist on a phone, and
 * revealing the only route to Duplicate on hover would make it unreachable
 * for a coach on the sideline with a tablet.
 */
export function MenuButton({
  label,
  children,
  trigger,
  triggerClassName,
}: {
  /** Names the menu for screen readers - "Actions for Week 3 Prep", not
   *  "More", so a list of twenty is not twenty identical buttons. */
  label: string;
  children: ReactNode;
  /** What the trigger shows. Defaults to the quiet "..." glyph.
   *
   *  Exists so a menu that is NOT a row's overflow - the header's account
   *  menu, which shows who you are signed in as - can look like itself
   *  without a second popover implementation being written for it. The
   *  positioning, the outside-click, the Escape handling and the on-screen
   *  clamping are the parts worth sharing; the glyph is not. */
  trigger?: ReactNode;
  triggerClassName?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  // Viewport coordinates for the open menu. See the positioning note below.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /* MEASURED AFTER THE MENU EXISTS, because clamping it to the screen needs
   * the menu's WIDTH, which does not exist until it renders - see
   * `menuRightOffset`. That is why this is a layout effect and not another
   * line in onClick. It runs before paint, so the coach never sees the
   * unclamped position. */
  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const t = trigger.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width;

    setAt({ top: t.bottom + 4, right: menuRightOffset(t.right, width, window.innerWidth) });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setIsOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      // Focus goes back to the trigger, not to the top of the page - a coach
      // who escapes out of a menu is still on the same quiz.
      triggerRef.current?.focus();
    }

    // A fixed menu is positioned against the viewport, so once the page moves
    // underneath it the coordinates are stale. Closing is the honest response -
    // and cheaper than tracking a moving target.
    function onMove() {
      setIsOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [isOpen]);

  return (
    <div
      className={styles.wrapper}
      ref={wrapperRef}
      // The card is a link. Without this, choosing an action would also
      // navigate - see the component docstring.
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ?? styles.trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        {trigger ?? <Icon name="more" size={16} />}
      </button>

      {isOpen && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          className={styles.menu}
          aria-label={label}
          // POSITIONED AGAINST THE VIEWPORT, NOT THE CARD, AND THIS IS THE
          // WHOLE FIX. `.card` is `overflow: hidden`, so an absolutely
          // positioned menu was clipped at the card's edge - when the trigger
          // sat low in a card, every item fell outside and became invisible
          // AND unclickable, with the card's own stretched link occupying
          // those coordinates. A coach reaching for "Move to" navigated into
          // the quiz instead. Measured, not theorised: 82px of the Move
          // control outside the card on a 375px viewport.
          //
          // `fixed` escapes ancestor overflow entirely. It is safe here
          // because nothing above these menus sets transform/filter/contain,
          // which would otherwise make a fixed element resolve against that
          // ancestor instead of the viewport.
          //
          // The coordinates come from the layout effect above, which also
          // keeps the menu inside the screen on a phone.
          style={at ? { top: at.top, right: at.right } : undefined}
        >
          <CloseMenu.Provider value={() => setIsOpen(false)}>{children}</CloseMenu.Provider>
        </div>
      )}
    </div>
  );
}

/** One action inside a MenuButton.
 *
 * `destructive` colours it and nothing else - the confirmation that actually
 * protects the coach lives where the action does, unchanged. */
export function MenuItem({
  children,
  onSelect,
  destructive = false,
  disabled = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  /** Shown but refusing, for an action the server would reject anyway. Say
   *  WHY in the label - a greyed item with no reason is a dead end the coach
   *  has to guess at. */
  disabled?: boolean;
}) {
  const close = useContext(CloseMenu);

  return (
    <button
      type="button"
      role="menuitem"
      className={`${styles.item} ${destructive ? styles.destructive : ''}`}
      disabled={disabled}
      onClick={() => {
        onSelect();
        close();
      }}
    >
      {children}
    </button>
  );
}

/** A real destination inside a MenuButton.
 *
 * A <Link>, not a button with navigate() in its onSelect, for the same reason
 * the section tabs are links: Admin View and Owner are addresses a coach can
 * bookmark, middle-click, or open in a second tab to compare against the one
 * they are on. Routing them through an onSelect handler would quietly take
 * all three away, and nothing about being inside a menu requires that.
 */
export function MenuLink({ to, children }: { to: string; children: ReactNode }) {
  const close = useContext(CloseMenu);

  return (
    <Link to={to} role="menuitem" className={styles.item} onClick={close}>
      {children}
    </Link>
  );
}
