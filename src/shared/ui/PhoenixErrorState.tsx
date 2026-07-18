import { PhoenixIcon } from './PhoenixIcon';

interface Props {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function PhoenixErrorState({ title = 'Error', message, onRetry }: Props) {
  return (
    <div className="nexus-error" role="alert">
      <div className="nexus-error__icon"><PhoenixIcon name="warning" size={23} /></div>
      <div className="nexus-error__copy">
        <div>{title}</div>
        <p>{message}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="nexus-error__retry premium-focus-ring">
          Retry / إعادة المحاولة
        </button>
      )}
    </div>
  );
}
