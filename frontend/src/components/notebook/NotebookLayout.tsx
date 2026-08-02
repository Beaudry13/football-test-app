import { Outlet } from 'react-router-dom';
import { NotebookPage } from './NotebookPage';
import { NotebookHeader } from './NotebookHeader';
import styles from '../../styles/notebook.module.css';

/** Authenticated-route wrapper for every notebook-themed page except the
 * Dashboard and quiz preview (which manage their own full-bleed content
 * width instead of the shared max-width column). Replaces the old
 * Layout.tsx for Team/Groups/GroupDetail/QuizEditor/AnnotationPage. */
export function NotebookLayout() {
  return (
    <NotebookPage>
      <NotebookHeader />
      <div className={styles.content}>
        <Outlet />
      </div>
    </NotebookPage>
  );
}
