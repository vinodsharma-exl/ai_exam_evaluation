import { AppProvider, useApp } from './lib/app-context';
import { RouterProvider, useRouter } from './lib/router';
import { api, call } from './lib/api';
import { Shell, Toasts } from './components/Shell';
import { PrivacyNoticeModal } from './components/PrivacyNotice';
import { Loading } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Welcome } from './screens/Welcome';
import { Dashboard } from './screens/Dashboard';
import { Evaluate } from './screens/Evaluate';
import { ExamsScreen, ExamSetupScreen } from './screens/Exams';
import { Processing } from './screens/Processing';
import { Results } from './screens/Results';
import { Students } from './screens/Students';
import { Reports } from './screens/Reports';
import { SettingsScreen } from './screens/Settings';
import { QuestionDetail } from './screens/QuestionDetail';
import { Finalize } from './screens/Finalize';
import { Report } from './screens/Report';

export function App() {
  return (
    <AppProvider>
      <RouterProvider>
        <Root />
        <Toasts />
      </RouterProvider>
    </AppProvider>
  );
}

function Root() {
  const { profile, config, updateConfig } = useApp();
  if (!profile) return <Welcome />;
  if (!config) return <Loading text="Opening your workspace…" />;
  return (
    <>
      <Shell>
        <GuardedScreen />
      </Shell>
      <PrivacyNoticeModal open={!config.privacyNoticeAcceptedAt} onAccept={() => void call(api.acceptPrivacyNotice()).then(() => updateConfig({}))} />
    </>
  );
}

function GuardedScreen() {
  const { route, go } = useRouter();
  return (
    <ErrorBoundary resetKey={route} onHome={() => go({ name: 'dashboard' })}>
      <Screen />
    </ErrorBoundary>
  );
}

function Screen() {
  const { route } = useRouter();
  switch (route.name) {
    case 'dashboard':
      return <Dashboard />;
    case 'evaluate':
      return <Evaluate key={`${route.examId}/${route.studentId}/${route.step}`} route={route} />;
    case 'exams':
      return <ExamsScreen />;
    case 'exam-setup':
      return <ExamSetupScreen key={route.examId} examId={route.examId} />;
    case 'processing':
      return <Processing key={`${route.examId}/${route.studentId}`} examId={route.examId} studentId={route.studentId} />;
    case 'results':
      return <Results key={`${route.examId}/${route.studentId}`} examId={route.examId} studentId={route.studentId} />;
    case 'students':
      return <Students initialQuery={route.query ?? ''} key={route.query ?? ''} />;
    case 'reports':
      return <Reports initialExamId={route.examId} />;
    case 'settings':
      return <SettingsScreen initialTab={route.tab} />;
    case 'question':
      return <QuestionDetail key={`${route.examId}/${route.studentId}`} examId={route.examId} studentId={route.studentId} questionNumber={route.questionNumber} />;
    case 'finalize':
      return <Finalize key={`${route.examId}/${route.studentId}`} examId={route.examId} studentId={route.studentId} />;
    case 'report':
      return <Report key={`${route.examId}/${route.studentId}`} examId={route.examId} studentId={route.studentId} />;
  }
}
