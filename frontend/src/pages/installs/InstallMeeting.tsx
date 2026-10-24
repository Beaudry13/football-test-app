import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { itemsInOrder, type Install } from '../../api/installs';
import type { GroupNeeds } from '../../api/players';
import { quizCache } from '../../components/teach/groupTeach';
import { TeachView } from '../../components/teach/TeachView';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import { itemTitle, loadTeachItem, type TeachContext, type TeachItem } from './installTeach';

/**
 * The meeting itself: one Teach screen walking the install. The next item is
 * fetched while the current one is taught, so Next is immediate.
 */
export function InstallMeeting({
  install,
  startAt = 0,
  groupNeeds,
  groupLabel,
  onClose,
}: {
  install: Install;
  startAt?: number;
  groupNeeds: () => Promise<GroupNeeds | null>;
  groupLabel: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const motionLab = useMayUseMotionLab();
  // Plays only for a coach who can open Motion Lab (its API refuses anyone else).
  const order = useMemo(() => itemsInOrder(install).filter((i) => motionLab || i.kind !== 'play'), [install, motionLab]);
  /** Which item is up - so leaving the meeting can come back to it. */
  const here = useRef(0);
  const back = () => ({ from: { to: `/installs/${install.id}?teach=1&at=${here.current}`, label: install.title } });
  const ctx = useRef<TeachContext>({
    navigate: (to: string) => navigate(to, { state: back() }),
    back,
    quizOf: quizCache(),
    groupNeeds,
    groupLabel,
  });
  const cache = useRef(new Map<number, Promise<TeachItem | null>>());
  const load = (index: number) => {
    const item = order[index];
    if (!item) return Promise.resolve(null);
    if (!cache.current.has(item.id)) cache.current.set(item.id, loadTeachItem(item, ctx.current).catch(() => null));
    return cache.current.get(item.id)!;
  };
  const [at, setAt] = useState(Math.min(Math.max(0, startAt), Math.max(0, order.length - 1)));
  /** Which way the coach was going - an empty item is passed over in that direction. */
  const heading = useRef<1 | -1>(1);
  /** Items found to have nothing to show: Next and Back skip them. */
  const [empty, setEmpty] = useState<ReadonlySet<number>>(() => new Set());
  const [shown, setShown] = useState<{ index: number; item: TeachItem } | null>(null);
  /** Every item turned out to have nothing to show. */
  const [nothing, setNothing] = useState(false);

  useEffect(() => {
    let live = true;
    void load(at).then((item) => {
      if (!live) return;
      if (item) {
        here.current = at;
        setShown({ index: at, item });
      }
      else {
        setEmpty((s) => new Set(s).add(at));
        const nextAt = at + heading.current;
        if (nextAt >= 0 && nextAt < order.length) setAt(nextAt);
        else if (shown) setAt(shown.index);
        else setNothing(true);
      }
    });
    void load(at + 1);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  const go = (index: number, way: 1 | -1) => {
    heading.current = way;
    setAt(index);
  };

  if (nothing) return <TeachView title={install.title} place="Nothing to teach yet" slides={[]} onClose={onClose} />;
  if (!shown) {
    return (
      <TeachView
        title={install.title}
        place="Getting the football…"
        slides={[{ key: 'loading', imageUrl: null, role: null, prompt: '', right: [], why: null, wrong: null, motionPlayId: null }]}
        onClose={onClose}
      />
    );
  }
  const nextIndex = order.findIndex((_, i) => i > shown.index && !empty.has(i));
  const prevIndex = order.findLastIndex((_, i) => i < shown.index && !empty.has(i));
  return (
    <TeachView
      title={shown.item.title}
      place={`${install.title} · ${shown.index + 1} of ${order.length}`}
      slides={shown.item.slides}
      start={shown.item.start ?? 0}
      room={shown.item.room ?? null}
      action={shown.item.action}
      next={nextIndex >= 0 ? { label: itemTitle(order[nextIndex]), onGo: () => go(nextIndex, 1) } : null}
      prev={prevIndex >= 0 ? { label: itemTitle(order[prevIndex]), onGo: () => go(prevIndex, -1) } : null}
      onClose={onClose}
    />
  );
}
