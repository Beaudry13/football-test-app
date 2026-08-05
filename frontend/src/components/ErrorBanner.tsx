import { Alert } from './ui/Alert';

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <Alert variant="error">{message}</Alert>;
}
