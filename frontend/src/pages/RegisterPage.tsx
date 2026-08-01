import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getErrorMessage } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import styles from './AuthPages.module.css';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', email: '', password: '', organization: '' });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await register(form);
      navigate('/');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className={styles.wrapper}>
      <form className={`card ${styles.form}`} onSubmit={handleSubmit}>
        <h2>Create a coach account</h2>
        <ErrorBanner message={error} />
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            required
            minLength={3}
            value={form.username}
            onChange={(e) => update('username', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="organization">Organization / team</label>
          <input
            id="organization"
            type="text"
            required
            value={form.organization}
            onChange={(e) => update('organization', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => update('password', e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={isSubmitting} style={{ width: '100%' }}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
        <p className={styles.footer}>
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
