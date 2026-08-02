import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { NotebookLayout } from './components/notebook/NotebookLayout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { TeamPage } from './pages/TeamPage';
import { JoinOrgPage } from './pages/JoinOrgPage';
import { QuizEditorPage } from './pages/quiz-editor/QuizEditorPage';
import { QuizPreviewPage } from './pages/quiz-editor/QuizPreviewPage';
import { AnnotationPage } from './pages/quiz-editor/AnnotationPage';
import { PlayPage } from './pages/play/PlayPage';
import { ResultsCheckPage } from './pages/play/ResultsCheckPage';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/join/:inviteCode" element={<JoinOrgPage />} />
          <Route path="/play" element={<PlayPage />} />
          <Route path="/play/:code" element={<PlayPage />} />
          <Route path="/results" element={<ResultsCheckPage />} />
          <Route path="/results/:code/:playerName" element={<ResultsCheckPage />} />

          <Route element={<ProtectedRoute />}>
            {/* Preview and the Dashboard are deliberately NOT nested in
                <NotebookLayout> - Preview shows exactly what a player sees
                (no coach nav), and the Dashboard manages its own
                full-bleed content width rather than NotebookLayout's
                shared max-width column. Both stay gated behind login via
                ProtectedRoute directly. */}
            <Route path="/quizzes/:quizId/preview" element={<QuizPreviewPage />} />
            <Route path="/" element={<DashboardPage />} />

            <Route element={<NotebookLayout />}>
              <Route path="/team" element={<TeamPage />} />
              <Route path="/groups" element={<GroupsPage />} />
              <Route path="/groups/:groupId" element={<GroupDetailPage />} />
              <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
              <Route
                path="/quizzes/:quizId/questions/:questionId/annotate"
                element={<AnnotationPage />}
              />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
