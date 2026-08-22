import { Link } from 'react-router-dom';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { PeiraLogo } from '../components/brand/PeiraLogo';
import styles from './HomePage.module.css';

const STEPS = [
  {
    numeral: 'I',
    title: 'Build a Quiz',
    body: 'Create a quiz for your team — any sport, any topic, anything you want to test them on.',
  },
  {
    numeral: 'II',
    title: 'Send It to Your Roster',
    body: 'Share the quiz with your team. Players complete it right from their phone — no app required.',
  },
  {
    numeral: 'III',
    title: 'See Who Rises',
    body: 'Track scores and completion in your dashboard, and see which players are ready for the next challenge.',
  },
];

/** Public marketing homepage - what an anonymous visitor sees at "/",
 * distinct from DashboardPage which a signed-in coach sees at the same
 * path (see RootRoute). Per the design handoff, but keeping the real
 * PeiraLogo mark rather than the handoff's placeholder rotated-diamond
 * glyph, per standing direction from the earlier dashboard redesign pass. */
export function HomePage() {
  return (
    <NotebookPage>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <PeiraLogo variant="light" />
        </Link>
        <nav className={styles.navActions}>
          <Link to="/login" className={styles.navBtnOutline}>
            Log In
          </Link>
          <Link to="/request-access" className={styles.navBtnFilled}>
            Request Access
          </Link>
        </nav>
      </header>

      <section className={styles.hero}>
        <div className={styles.eyebrow}>A Quiz Platform for Coaches</div>
        <h1 className={styles.heroHeading}>
          Every trial has
          <br />
          its coach.
        </h1>
        <p className={styles.heroBody}>
          Peira lets coaches build quizzes, send them to their roster, and track who rises to the
          challenge. It’s in early access — we’re building it alongside a small number of
          programs.
        </p>
        <div className={styles.heroActions}>
          {/* Peira is invite-only for now, so the honest public action is to
              ask. An invited coach arrives through their own link and never
              needs a button here. */}
          <Link to="/request-access" className={styles.heroBtnFilled}>
            Request Early Access
          </Link>
          <Link to="/login" className={styles.heroBtnOutline}>
            Log In
          </Link>
        </div>
      </section>

      <section className={styles.whatIsPeira}>
        <PeiraLogo variant="dark" markOnly size={48} className={styles.whatIsPeiraMark} />
        <h2 className={styles.whatIsPeiraHeading}>What is Peira?</h2>
        <p className={styles.whatIsPeiraText}>
          In Greek, <em className={styles.highlight}>peîra</em> (πεῖρα) means{' '}
          <em className={styles.highlight}>trial, test, proof through experience</em>.
        </p>
        <p className={styles.whatIsPeiraText}>
          Every quiz a coach sends is a trial — a chance for players to prove what they know.
          Peira gives coaches the tools to build quizzes and see who rises to the challenge.
        </p>
      </section>

      <section className={styles.howItWorks}>
        <h2 className={styles.howItWorksHeading}>How It Works</h2>
        <div className={styles.howItWorksRule} />
        <div className={styles.stepsGrid}>
          {STEPS.map((step) => (
            <div key={step.numeral} className={styles.step}>
              <div className={styles.stepNumeral}>{step.numeral}</div>
              <div className={styles.stepTitle}>{step.title}</div>
              <div className={styles.stepBody}>{step.body}</div>
            </div>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>© 2026 Peira. For coaches who put their team to the test.</footer>
    </NotebookPage>
  );
}
