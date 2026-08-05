import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './Alert.module.css';

export type AlertVariant = 'error' | 'success' | 'warning' | 'info';

const VARIANT_ICON: Record<AlertVariant, IconName> = {
  error: 'close',
  success: 'check',
  warning: 'info',
  info: 'info',
};

interface AlertProps {
  variant?: AlertVariant;
  children: ReactNode;
}

/** Generalizes what ErrorBanner used to be the only version of - a small
 * inline banner, now with a `variant` so success/warning/info messaging
 * shares the same shape and token-driven colors instead of each page
 * inventing its own. */
export function Alert({ variant = 'error', children }: AlertProps) {
  return (
    <div className={`${styles.alert} ${styles[variant]}`} role={variant === 'error' ? 'alert' : 'status'}>
      <Icon name={VARIANT_ICON[variant]} size={16} className={styles.icon} />
      <div>{children}</div>
    </div>
  );
}
