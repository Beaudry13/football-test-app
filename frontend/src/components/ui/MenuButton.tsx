import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
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
}: {
  /** Names the menu for screen readers - "Actions for Week 3 Prep", not
   *  "More", so a list of twenty is not twenty identical buttons. */
  label: string;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

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

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
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
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Icon name="more" size={16} />
      </button>

      {isOpen && (
        <div
          id={menuId}
          role="menu"
          className={styles.menu}
          aria-label={label}
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
}: {
  children: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  const close = useContext(CloseMenu);

  return (
    <button
      type="button"
      role="menuitem"
      className={`${styles.item} ${destructive ? styles.destructive : ''}`}
      onClick={() => {
        onSelect();
        close();
      }}
    >
      {children}
    </button>
  );
}
