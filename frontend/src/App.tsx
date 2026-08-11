import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { TourProvider } from './help/tour/TourProvider';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { NotFoundRedirect } from './auth/NotFoundRedirect';
import { NotebookLayout } from './components/notebook/NotebookLayout';
import { HomePage } from './pages/HomePage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { FolderPage } from './pages/FolderPage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { TeamPage } from './pages/TeamPage';
import { PlayerHistoryPage } from './pages/PlayerHistoryPage';
import { MasterRosterPage } from './pages/MasterRosterPage';
import { PlayerProfilePage } from './pages/PlayerProfilePage';
import { JoinOrgPage } from './pages/JoinOrgPage';
import { QuizEditorPage } from './pages/quiz-editor/QuizEditorPage';
import { QuizPreviewPage } from './pages/quiz-editor/QuizPreviewPage';
import { AnnotationPage } from './pages/quiz-editor/AnnotationPage';
import { AdminQuizzesPage } from './pages/admin/AdminQuizzesPage';
import { OwnerLayout } from './pages/owner/OwnerLayout';
import { OwnerOverviewPage } from './pages/owner/OwnerOverviewPage';
import { OwnerOrganizationsPage } from './pages/owner/OwnerOrganizationsPage';
import { OwnerOrganizationDetailPage } from './pages/owner/OwnerOrganizationDetailPage';
import { OwnerCoachesPage } from './pages/owner/OwnerCoachesPage';
import { DocumentsPage } from './pages/documents/DocumentsPage';
import { DocumentPage } from './pages/documents/DocumentPage';
import { PlayPage } from './pages/play/PlayPage';
import { ResultsCheckPage } from './pages/play/ResultsCheckPage';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* Inside the router because launching the tour navigates to the
            dashboard, and inside auth because both launchers are behind
            login. Mounts the overlay once for the whole app. */}
        <TourProvider>
        <Routes>
          {/* "/" is always the public marketing homepage, signed in or not -
              a coach who wants their dashboard uses the nav/logo (which
              point at /dashboard) rather than the bare root landing them
              back in the app automatically every time they open the site. */}
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/join/:inviteCode" element={<JoinOrgPage />} />
          <Route path="/play" element={<PlayPage />} />
          <Route path="/play/:code" element={<PlayPage />} />
          <Route path="/results" element={<ResultsCheckPage />} />
          <Route path="/results/:code/:playerName" element={<ResultsCheckPage />} />

          <Route element={<ProtectedRoute />}>
            {/* Preview and Dashboard are deliberately NOT nested in
                <NotebookLayout> - they render their own chrome. Stays
                gated behind login via ProtectedRoute directly. */}
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/quizzes/:quizId/preview" element={<QuizPreviewPage />} />
            <Route path="/folders/:folderId" element={<FolderPage />} />

            <Route element={<NotebookLayout />}>
              <Route path="/team" element={<TeamPage />} />
              <Route path="/admin/quizzes" element={<AdminQuizzesPage />} />
              {/* PEIRA OWNER DASHBOARD - a level above organizations, not a
                  section of Admin View. Rendering these routes is not a
                  permission: every screen fetches from /api/owner, which
                  enforces platform ownership server-side, so a non-owner who
                  types the URL gets 404s and an empty page rather than data. */}
              <Route path="/owner" element={<OwnerLayout />}>
                <Route index element={<OwnerOverviewPage />} />
                <Route path="organizations" element={<OwnerOrganizationsPage />} />
                <Route
                  path="organizations/:organizationId"
                  element={<OwnerOrganizationDetailPage />}
                />
                <Route path="coaches" element={<OwnerCoachesPage />} />
              </Route>
              <Route path="/documents" element={<DocumentsPage />} />
              <Route path="/documents/:documentId" element={<DocumentPage />} />
              <Route path="/roster" element={<MasterRosterPage />} />
              <Route path="/roster/:playerId" element={<PlayerProfilePage />} />
              <Route path="/groups" element={<GroupsPage />} />
              <Route path="/groups/:groupId" element={<GroupDetailPage />} />
              <Route path="/players/:playerName/history" element={<PlayerHistoryPage />} />
              <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
              <Route
                path="/quizzes/:quizId/questions/:questionId/annotate"
                element={<AnnotationPage />}
              />
            </Route>
          </Route>

          <Route path="*" element={<NotFoundRedirect />} />
        </Routes>
        </TourProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
